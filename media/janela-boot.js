/*
 * Runs inside the webview, after xpra's own index.html script has run.
 *
 * It does two things the stock client cannot do for us:
 *
 *   1. Points the client at the tunnelled server. index.html reads the host
 *      from `getstrparam("server")`, which strips every character outside
 *      "0-9A-Za-z _+-:" -- dots included. That turns 127.0.0.1 into 127001, so
 *      the parameter route is unusable. We override connect() instead.
 *
 *   2. Grabs input. Capture-phase listeners on `window` run before anything on
 *      `document` -- including the forwarder VS Code's webview preamble
 *      installs -- so while the grab is on, its keybinding service never sees
 *      the event and the key goes straight to the client's own handler. Right
 *      click, wheel-zoom and text selection go the same way.
 */
(function () {
  "use strict";

  var CFG = window.__JANELA__ || {};
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  // What VS Code hands back after a restart, so the extension knows which
  // session and which window this frame was showing. Without it a restored tab
  // is a blank frame nobody can identify.
  if (api && typeof api.setState === "function") {
    try {
      api.setState({ display: CFG.display, wid: CFG.onlyWindow });
    } catch (error) {
      /* a page that cannot remember is still a page that works */
    }
  }
  var grabbed = !!CFG.grabOnOpen;

  function post(type, payload) {
    if (!api) {
      return;
    }
    var message = { type: type };
    for (var key in payload || {}) {
      message[key] = payload[key];
    }
    api.postMessage(message);
  }

  // --- 1. connect to the tunnelled server ---------------------------------
  function patchConnect() {
    if (typeof XpraClient === "undefined" || XpraClient.__janela) {
      return typeof XpraClient !== "undefined";
    }
    var connect = XpraClient.prototype.connect;
    XpraClient.prototype.connect = function () {
      this.host = CFG.host;
      this.port = CFG.port;
      this.ssl = !!CFG.ssl;
      this.path = CFG.path || "/";
      // index.html:908-911 does exactly this with the values it parsed from the
      // URL; we have them from the extension instead. `passwords` is a list
      // because the client tries them in order against the server's challenge.
      if (CFG.password) {
        this.username = CFG.username || "";
        this.passwords = [CFG.password];
      }
      post("state", {
        state: "connecting",
        detail: (CFG.ssl ? "wss" : "ws") + "://" + CFG.host + ":" + CFG.port,
      });
      // Before the connection, so every window is created under the final
      // scale: they capture it once and configure their dragging from it. In
      // single-window mode there is no desktop to scale - the window is sized
      // once it exists, which is after the connection, not before it.
      if (ONLY === null) {
        fitToWindow();
      }
      return connect.apply(this, arguments);
    };
    XpraClient.__janela = true;
    return true;
  }

  if (!patchConnect()) {
    // Client.js has not run yet: try again once the document is parsed.
    document.addEventListener("DOMContentLoaded", patchConnect, true);
  }

  // --- 1a. make reconnecting possible at all -------------------------------
  //
  // `close_protocol()` calls `this.protocol.close()` and then
  // `this.protocol.terminate()`. Only the worker host has `terminate`; the
  // plain `XpraProtocol` does not. We hide `window.Worker` deliberately - a
  // webview's scripts are cross-origin to its own page, so constructing one
  // throws (ADR 0001) - which means the plain protocol is the only one we ever
  // use, and every reconnect died on that call before reaching `connect()`.
  //
  // So reconnecting had never worked. A fresh page load was the only way back,
  // which is exactly what "reconnecting is unreliable" felt like from outside.
  function patchProtocol() {
    var Protocol;
    try {
      Protocol = typeof XpraProtocol === "undefined" ? null : XpraProtocol;
    } catch (error) {
      return false;
    }
    if (!Protocol) {
      return false;
    }
    if (!Protocol.prototype.terminate) {
      // close() has already released the socket; there is no worker to end.
      Protocol.prototype.terminate = function () {};
    }
    return true;
  }

  if (!patchProtocol()) {
    document.addEventListener("DOMContentLoaded", patchProtocol, true);
  }

  // --- 1b. one application window per OS window ----------------------------
  //
  // When CFG.onlyWindow is set this panel shows exactly one of the session's
  // windows. Every client is told about every window, so the filtering happens
  // here - and the important half is what it does NOT do: Client.js sends
  // `map_window` from inside _new_window, so a window we never create is a
  // window the server never sends pixels for. Four windows therefore cost four
  // metadata streams and four pixel streams, not sixteen.
  //
  // Menus and tooltips are the exception. X11 gives them no window manager and
  // no decoration, and they belong over the window they cover; an OS window of
  // their own would arrive with a title bar and take focus from the menu it is
  // part of. So an override-redirect window that overlaps ours is drawn here,
  // shifted into our coordinates. One that does not overlap belongs to somebody
  // else's panel.
  var ONLY = CFG.onlyWindow === null || CFG.onlyWindow === undefined ? null : Number(CFG.onlyWindow);
  var own = null;

  function overlapsOwn(x, y, w, h) {
    return (
      own !== null &&
      x < own.x + own.w &&
      x + w > own.x &&
      y < own.y + own.h &&
      y + h > own.y
    );
  }

  function titleOf(metadata) {
    return (metadata && (metadata.title || metadata["title"])) || "";
  }

  function patchWindows() {
    if (typeof XpraClient === "undefined" || XpraClient.__janelaWindows) {
      return typeof XpraClient !== "undefined";
    }
    var newWindow = XpraClient.prototype._new_window;
    XpraClient.prototype._new_window = function (wid, x, y, w, h, metadata, overrideRedirect, properties) {
      // Reported whatever we do with it: this is how the extension learns a
      // window appeared without polling the server over ssh.
      post("window", {
        wid: wid,
        title: titleOf(metadata),
        overrideRedirect: !!overrideRedirect,
        x: x,
        y: y,
        width: w,
        height: h,
      });

      if (ONLY === null) {
        return newWindow.apply(this, arguments);
      }
      if (wid === ONLY) {
        own = { x: x, y: y, w: w, h: h };
        // At the origin, because this panel is the window: its position on the
        // session's desktop is not something the user can see or should feel.
        return newWindow.call(this, wid, 0, 0, w, h, metadata, overrideRedirect, properties);
      }
      if (overrideRedirect && overlapsOwn(x, y, w, h)) {
        return newWindow.call(this, wid, x - own.x, y - own.y, w, h, metadata, overrideRedirect, properties);
      }
      return undefined;
    };

    var lost = XpraClient.prototype._process_lost_window;
    XpraClient.prototype._process_lost_window = function (packet) {
      var wid = packet[1];
      post("window-gone", { wid: wid });
      if (ONLY !== null && wid === ONLY) {
        own = null;
      }
      // The client warns about a window it never created; harmless, and quieter
      // than reimplementing its bookkeeping here.
      if (ONLY !== null && !this.id_to_window[wid]) {
        return undefined;
      }
      return lost.apply(this, arguments);
    };

    var metadata = XpraClient.prototype._process_window_metadata;
    XpraClient.prototype._process_window_metadata = function (packet) {
      if (ONLY !== null && packet[1] === ONLY) {
        post("window-title", { wid: packet[1], title: titleOf(packet[2]) });
      }
      if (ONLY !== null && !this.id_to_window[packet[1]]) {
        return undefined;
      }
      return metadata.apply(this, arguments);
    };

    XpraClient.__janelaWindows = true;
    return true;
  }

  if (!patchWindows()) {
    document.addEventListener("DOMContentLoaded", patchWindows, true);
  }

  // The panel is the window frame, so its size is the application's size. This
  // replaces the desktop scaling below, which exists because an Xvfb
  // framebuffer cannot be resized - a single window can.
  function fitOwnWindow() {
    var client = currentClient();
    if (ONLY === null || !client || !client.id_to_window) {
      return;
    }
    var win = client.id_to_window[ONLY];
    if (!win) {
      return;
    }
    var width = Math.max(64, Math.floor(window.innerWidth));
    var height = Math.max(64, Math.floor(window.innerHeight));
    try {
      win.move_resize(0, 0, width, height);
      client.send_configure_window(win, {}, false);
    } catch (error) {
      post("error", { message: "resize window " + ONLY + ": " + error });
    }
  }

  // --- 2. fit the remote desktop into the tab ------------------------------
  //
  // The session's screen is a fixed-size Xvfb framebuffer: xpra asks it to
  // match the client and it cannot comply, so a 1920x1080 desktop in a smaller
  // tab is simply cropped. (This is what Xdummy exists for, and Xdummy needs
  // root.) Scaling the container is the client's own answer: it renders the
  // whole desktop at full size and transforms it down, and divides pointer
  // coordinates by the same factor so clicks still land where they look.
  function screenElement() {
    var c = currentClient();
    return (c && c.container) || document.getElementById("screen");
  }

  function applyScale(scale) {
    var container = screenElement();
    if (!container) {
      return;
    }
    var c = currentClient();
    if (c) {
      c.scale = scale;
      rescaleWindows(c, scale);
    }
    if (scale === 1) {
      container.style.width = "";
      container.style.height = "";
      container.style.transform = "";
    } else {
      container.style.width = 100 * scale + "%";
      container.style.height = 100 * scale + "%";
      container.style.transform = "scale(" + 1 / scale + ")";
      container.style.transformOrigin = "top left";
    }
    if (c && c.connected) {
      // Tell the server the usable area changed, so windows can lay out to it.
      try {
        c._screen_resized();
      } catch (error) {
        post("error", { message: "screen_resized: " + error });
      }
    }
  }

  /**
   * Every window captures `client.scale` when it is created (Client.js:3212)
   * and configures jQuery UI from it: `make_draggable` only passes
   * `transform: true` when the scale is not 1 (Window.js:283). A window created
   * before the scale changed therefore drags in untransformed pixels while the
   * pointer moves in scaled ones - the window follows, but not under the
   * cursor. Updating the value is not enough; the draggable has to be rebuilt.
   */
  function rescaleWindows(c, scale) {
    var windows = c.id_to_window || {};
    for (var wid in windows) {
      var win = windows[wid];
      if (!win || win.scale === scale || !win.div) {
        continue;
      }
      win.scale = scale;
      ["draggable", "resizable"].forEach(function (widget) {
        try {
          if (window.jQuery && window.jQuery(win.div)[widget]("instance")) {
            window.jQuery(win.div)[widget]("destroy");
          }
        } catch (error) {
          /* not initialised yet; make_* below will set it up */
        }
      });
      try {
        win.make_draggable();
        win.make_resizable();
      } catch (error) {
        post("error", { message: "rescale window " + wid + ": " + error });
      }
    }
  }

  var lastScale = 0;
  function fitToWindow() {
    var width = CFG.desktopWidth;
    var height = CFG.desktopHeight;
    if (!width || !height) {
      return; // nothing known about the remote screen: leave it 1:1
    }
    var visibleWidth = window.innerWidth || document.documentElement.clientWidth;
    var visibleHeight = window.innerHeight || document.documentElement.clientHeight;
    if (!visibleWidth || !visibleHeight) {
      return;
    }
    // Only ever shrink. Blowing a small desktop up to fill a large tab would
    // magnify every pixel, which for a waveform is worse than empty space.
    var scale = Math.max(width / visibleWidth, height / visibleHeight, 1);
    scale = Math.round(scale * 1000) / 1000;
    if (scale === lastScale) {
      return;
    }
    lastScale = scale;
    applyScale(scale);
    post("scale", { scale: scale, desktop: width + "x" + height });
  }

  var fitTimer = null;
  // Showing one window means resizing the application, not scaling a desktop:
  // the panel IS the frame. Showing the whole session means scaling, because an
  // Xvfb framebuffer is a fixed size and cannot follow the tab.
  function fit() {
    if (ONLY === null) {
      fitToWindow();
    } else {
      fitOwnWindow();
    }
  }

  window.addEventListener("resize", function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fit, 250);
  });

  // --- 3. the grab ----------------------------------------------------------
  //
  // Listeners go on `window`, in the capture phase. That matters: capture runs
  // outermost-first, so a listener here fires before ANY listener on
  // `document` - including the one VS Code's webview preamble installs to
  // forward keystrokes to its keybinding service. On `document` we would be
  // competing with it by registration order and losing.
  //
  // What cannot be taken, however aggressive this gets: Alt+Tab, the Windows
  // key, Ctrl+Alt+Del. The OS claims those before any browser sees them.
  var MODE = CFG.grabMode || "pointer";
  var suspended = false; // released by the chord, until the pointer leaves and returns
  var pointerInside = MODE === "always";

  function currentClient() {
    // `client` is a top-level `let` in index.html: a global lexical binding,
    // not a property of window, and in the temporal dead zone until the page
    // initialises. Both cases throw, so both are caught.
    try {
      return typeof client === "undefined" ? null : client;
    } catch (error) {
      return null;
    }
  }

  function setGrab(value) {
    grabbed = !!value;
    tryKeyboardLock(grabbed);
    // Mirrored onto the root element: the only way to see the grab state from
    // outside the closure, which both styling and the spike rely on.
    try {
      document.documentElement.setAttribute("data-janela-grab", grabbed ? "on" : "off");
      document.documentElement.setAttribute("data-janela-mode", MODE);
    } catch (error) {
      /* no document yet */
    }
    var c = currentClient();
    if (c) {
      // Stop the client fighting us for focus-driven capture.
      c.capture_keyboard = grabbed;
    }
    post("grab", { grabbed: grabbed });
  }

  function shouldGrab() {
    if (MODE === "always") {
      return !suspended;
    }
    if (MODE === "manual") {
      return grabbed;
    }
    return pointerInside && !suspended;
  }

  function refreshGrab() {
    var want = shouldGrab();
    if (want !== grabbed) {
      setGrab(want);
    }
  }

  // Chrome's Keyboard Lock would capture even Escape and Ctrl+W. It needs
  // fullscreen and a permission this iframe does not have - the same policy
  // that already blocks getLayoutMap() here - so it is attempted and ignored.
  function tryKeyboardLock(on) {
    try {
      if (navigator.keyboard && navigator.keyboard.lock) {
        if (on) {
          navigator.keyboard.lock();
        } else if (navigator.keyboard.unlock) {
          navigator.keyboard.unlock();
        }
      }
    } catch (error) {
      /* not available in a webview; the capture-phase handlers do the work */
    }
  }

  function isGrabToggle(event) {
    return event.ctrlKey && event.altKey && event.code === "KeyG";
  }

  function handler(down) {
    return function (event) {
      if (isGrabToggle(event)) {
        if (down) {
          suspended = !suspended;
          refreshGrab();
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!grabbed) {
        return; // released: VS Code keeps its keybindings
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      var c = currentClient();
      if (!c) {
        return;
      }
      try {
        if (down) {
          c._keyb_onkeydown(event);
        } else {
          c._keyb_onkeyup(event);
        }
      } catch (error) {
        post("error", { message: String(error) });
      }
    };
  }

  window.addEventListener("keydown", handler(true), true);
  window.addEventListener("keyup", handler(false), true);
  // keypress carries nothing xpra needs, but left alone it still reaches VS Code.
  window.addEventListener(
    "keypress",
    function (event) {
      if (grabbed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  // Right-click belongs to the remote application. Swallowing `contextmenu`
  // stops the editor's copy/paste menu without touching the mousedown the
  // client needs to send button 3 onwards.
  window.addEventListener(
    "contextmenu",
    function (event) {
      if (grabbed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  // Things a browser does with a mouse that a remote desktop should not
  // inherit: text selection, drag-and-drop, and Ctrl+wheel zooming. The wheel
  // event is only prevented, never stopped, because the client still wants it.
  ["dragstart", "selectstart"].forEach(function (name) {
    window.addEventListener(
      name,
      function (event) {
        if (grabbed) {
          event.preventDefault();
        }
      },
      true,
    );
  });
  window.addEventListener(
    "wheel",
    function (event) {
      if (grabbed) {
        event.preventDefault();
      }
    },
    { capture: true, passive: false },
  );

  // The pointer decides, which is how a VM console behaves: keystrokes go to
  // whatever the mouse is over. The chord is the escape hatch, and it lasts
  // until the pointer leaves and comes back.
  function pointerEntered() {
    if (!pointerInside) {
      pointerInside = true;
      refreshGrab();
    }
  }

  function pointerLeft() {
    if (pointerInside) {
      pointerInside = false;
      suspended = false; // a fresh entry starts grabbed again
      refreshGrab();
    }
  }

  // Several signals, because no single one is reliable everywhere: mouseleave
  // on the root, and mouseout with no relatedTarget, which is what a pointer
  // crossing the document boundary actually produces.
  [document, document.documentElement].forEach(function (target) {
    if (!target) {
      return;
    }
    target.addEventListener("mouseenter", pointerEntered, true);
    target.addEventListener("mouseleave", pointerLeft, true);
  });
  document.addEventListener(
    "mouseover",
    function () {
      pointerEntered();
    },
    true,
  );
  document.addEventListener(
    "mouseout",
    function (event) {
      if (!event.relatedTarget) {
        pointerLeft();
      }
    },
    true,
  );
  window.addEventListener("blur", function () {
    pointerInside = false;
    refreshGrab();
  });
  window.addEventListener("focus", function () {
    if (MODE === "always") {
      refreshGrab();
    }
  });

  // `Janela: Toggle Keyboard Grab` from the palette or the status bar arrives
  // here. In pointer mode it flips the same suspension the chord does, so the
  // two controls cannot disagree.
  window.addEventListener("message", function (event) {
    var message = event.data || {};
    if (message.type === "tunnel") {
      tunnelState = message.state;
      if (message.state === "up") {
        var c = currentClient();
        // Recovery, not confirmation: only reload if this page had lost
        // something. Otherwise the message that arrives as a panel opens would
        // reload it before it ever finished connecting.
        if (sawTrouble && (!c || !c.connected)) {
          reconnectNow();
        } else if (c && c.connected) {
          hideOverlay();
        }
      } else if (message.state === "retrying") {
        sawTrouble = true;
        showOverlay(
          "Connection lost",
          (message.detail ? message.detail + " \u2014 " : "") + "Reconnecting automatically."
        );
      }
      return;
    }
    if (message.type !== "setGrab") {
      return;
    }
    if (MODE === "manual") {
      setGrab(message.value);
    } else {
      suspended = !message.value;
      refreshGrab();
    }
  });

  // --- 5. say what the connection is doing, on the glass --------------------
  //
  // A dropped link used to look exactly like a hung application: the window
  // simply stopped repainting and nothing anywhere said why. The client's own
  // budget made it worse - five attempts a second apart, after a fifteen second
  // ping timeout - so a laptop shut for ten minutes was disconnected for good.
  //
  // Now it keeps trying, with a backoff that settles rather than gives up, and
  // the page says where it stands.
  var overlay = null;
  var overlayText = null;
  var overlayDetail = null;
  var overlayButton = null;
  var tunnelState = "up";

  function buildOverlay() {
    if (overlay) {
      return overlay;
    }
    overlay = document.createElement("div");
    overlay.setAttribute("data-janela", "overlay");
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647", "display:none",
      "align-items:center", "justify-content:center", "flex-direction:column",
      "gap:14px", "font-family:system-ui,-apple-system,Segoe UI,sans-serif",
      "background:rgba(20,20,20,0.82)", "color:#f4f4f4", "backdrop-filter:blur(2px)",
    ].join(";");

    var spinner = document.createElement("div");
    spinner.style.cssText = [
      "width:26px", "height:26px", "border-radius:50%",
      "border:3px solid rgba(255,255,255,0.25)", "border-top-color:#f4f4f4",
      "animation:janela-spin 0.9s linear infinite",
    ].join(";");

    var style = document.createElement("style");
    style.textContent = "@keyframes janela-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);

    overlayText = document.createElement("div");
    overlayText.style.cssText = "font-size:1.15em;font-weight:600";
    overlayDetail = document.createElement("div");
    overlayDetail.style.cssText = [
      "font-size:0.92em", "max-width:70ch", "text-align:center", "line-height:1.5",
      "color:var(--vscode-descriptionForeground,rgba(255,255,255,0.7))",
    ].join(";");
    overlayButton = document.createElement("button");
    overlayButton.textContent = "Reconnect now";
    overlayButton.style.cssText = [
      "font:inherit", "padding:6px 16px", "border-radius:2px", "border:none",
      "background:var(--vscode-button-background,#0e639c)",
      "color:var(--vscode-button-foreground,#ffffff)", "cursor:pointer",
    ].join(";");
    overlayButton.addEventListener("mouseenter", function () {
      overlayButton.style.background = "var(--vscode-button-hoverBackground,#1177bb)";
    });
    overlayButton.addEventListener("mouseleave", function () {
      overlayButton.style.background = "var(--vscode-button-background,#0e639c)";
    });
    overlayButton.addEventListener("click", function () {
      reconnectNow();
    });

    overlay.appendChild(spinner);
    overlay.appendChild(overlayText);
    overlay.appendChild(overlayDetail);
    overlay.appendChild(overlayButton);
    document.body.appendChild(overlay);
    return overlay;
  }

  function showOverlay(title, detail) {
    buildOverlay();
    // When the client gives up, index.html rebuilds the page around its own
    // connect form and our node goes with it. Setting `display` on a detached
    // element shows nothing at all, which is how a covered failure managed to
    // look exactly like an uncovered one.
    if (!overlay.isConnected && document.body) {
      document.body.appendChild(overlay);
    }
    overlayText.textContent = title;
    overlayDetail.textContent = detail || "";
    overlay.style.display = "flex";
  }

  function hideOverlay() {
    if (overlay) {
      overlay.style.display = "none";
    }
  }

  // Recovery is a page reload, not the client's own retry.
  //
  // That is a deliberate retreat. The client does have a reconnect, and it does
  // not survive contact with a link that is actually down: the first failed
  // attempt sets `reconnect = false`, closes the client, and hands the page
  // back to xpra's own connect form - at which point `client` no longer exists
  // and nothing can retry anything. Loading the page again is the one path that
  // has always worked, and there is nothing in the page worth preserving: every
  // piece of state belongs to the session, which is on the server and never
  // went anywhere.
  var reloading = false;
  // Whether this page has actually lost something. A page that has only just
  // opened has not: telling it the tunnel is up is confirmation, not recovery,
  // and reloading on that put every panel in a reload loop, so it never lived
  // long enough to connect.
  var sawTrouble = false;

  // index.html installs `client.callback_close`, and it navigates:
  //
  //     window.location = "connect.html";
  //
  // That replaces the whole document with xpra's connect form, taking this
  // script, the overlay, and any possibility of reconnecting with it. It is the
  // single reason a dropped link was unrecoverable - the window did not freeze,
  // it went somewhere else. We own that callback instead.
  function patchClose() {
    var c = currentClient();
    if (!c || c.__janelaClose) {
      return !!c;
    }
    c.__janelaClose = true;
    c.callback_close = function (reason) {
      sawTrouble = true;
      post("state", { state: "disconnected", detail: String(reason || "") });
      showOverlay(
        "Connection lost",
        (reason ? String(reason) + " \u2014 " : "") +
          (tunnelState === "up" ? "Trying again." : "Waiting for the connection to come back.")
      );
    };
    return true;
  }

  function reconnectNow() {
    if (reloading) {
      return;
    }
    reloading = true;
    showOverlay("Reconnecting\u2026", "");
    // A beat, so the overlay paints before the document goes away.
    setTimeout(function () {
      location.reload();
    }, 50);
  }

  // --- 4. tell the extension what the connection is doing ------------------
  var lastState = "";
  var ticks = 0;
  // Only complain about losing a connection we actually had; a page still
  // opening its first one is not a failure.
  var everConnected = false;
  setInterval(function () {
    var c = currentClient();
    var state = !c ? "starting" : c.connected ? "connected" : "disconnected";
    patchClose();
    ticks++;
    if (state !== lastState) {
      lastState = state;
      post("state", { state: state });
      if (state === "connected") {
        hideOverlay();
        // The container only exists once the client has built it.
        fit();
      }
    }
    // Independent of the transition above: once the client has given up it
    // stops existing, and the page falls back to xpra's connect form. The
    // overlay covers that and says what is really happening.
    if (state !== "connected" && (everConnected || ticks > 5) && !reloading) {
      showOverlay(
        "Connection lost",
        tunnelState === "up"
          ? "Trying to reach the session again."
          : "Waiting for the connection to the server to come back."
      );
    }
    if (state === "connected") {
      everConnected = true;
    } else if (everConnected) {
      sawTrouble = true;
    }
  }, 1000);

  refreshGrab();
  post("grab", { grabbed: grabbed });
})();
