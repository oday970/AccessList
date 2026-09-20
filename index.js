(function(){
  "use strict";

  var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============================================================
     THE NEBULA FIELD

     Randomised per load, within a fixed palette: near-black navy and
     indigo carry the ground, and the clouds are drawn from deep blue,
     indigo, violet, purple, magenta and — occasionally — dusty pink.
     Weighted so indigo and violet dominate and pink is rare. Hue is
     never allowed outside 195-346deg, which is what keeps green, yellow
     and orange off the page by construction rather than by taste.

     Saturation stays moderate-to-high and lightness stays very low, so
     the colour reads as pigment in the dark rather than as a glow.

     WHY THIS CAN BE COLOURFUL AND STILL DARK. Relative luminance is 71%
     green, 21% red and only 7% blue. Violet, indigo and magenta are
     almost entirely blue and red, so they cost very little of the
     contrast budget no matter how saturated they get. That is the whole
     trick, and it is also why the forbidden hues are forbidden: green,
     yellow and orange would spend the budget immediately.

     THE CEILING. Randomness and a contrast guarantee do not mix: a bad
     draw could stack three clouds in one place and lift the ground out
     from under the text. --accent (#4f8cff), the weakest thing that has
     to stay readable at 4.5:1, tolerates a background luminance of
     0.0225 -- but cards lay --surf over the field, which lightens it
     again, so the raw field is held to 0.013 to leave that room.

     The field is measured after painting and, if its brightest pixel is
     over CEIL, every alpha is scaled down until it is not. The search is
     exact rather than a single guessed factor: luminance is not linear
     in alpha, and an approximation here would leave the guarantee not
     quite holding. So the palette below is pushed as hard as it can be
     and the clamp decides what actually survives -- the field ends up as
     vivid as the contrast budget allows, and never more.
     ============================================================ */
  var CEIL = 0.013;

  function paintNebula(){
    var c = document.getElementById("nebula");
    if (!c || !c.getContext) return;

    // a sixth of the viewport: the upscale is the blur
    var w = Math.max(8, Math.round(c.clientWidth / 6));
    var h = Math.max(8, Math.round(c.clientHeight / 6));
    c.width = w; c.height = h;

    var x = c.getContext("2d");
    var rnd = function(a, b){ return a + Math.random() * (b - a); };

    // [hueLow, hueHigh, weight] -- no band strays outside 195-346
    var BANDS = [
      [196, 212, 1.0],   // cyan-blue
      [220, 244, 3.0],   // deep blue into indigo
      [244, 272, 3.2],   // indigo into violet
      [272, 292, 2.2],   // purple
      [300, 322, 1.4],   // magenta
      [330, 346, 0.7]    // dusty pink, occasional
    ];
    var total = 0, i;
    for (i = 0; i < BANDS.length; i++) total += BANDS[i][2];
    function hue(){
      var r = Math.random() * total;
      for (var j = 0; j < BANDS.length; j++) {
        r -= BANDS[j][2];
        if (r <= 0) return rnd(BANDS[j][0], BANDS[j][1]);
      }
      return rnd(244, 272);
    }

    x.clearRect(0, 0, w, h);
    // additive, so overlapping clouds bloom into each other the way real
    // emission nebulae do rather than flatly covering one another
    x.globalCompositeOperation = "lighter";

    var span = Math.max(w, h);
    var count = Math.round(rnd(7, 12));
    for (i = 0; i < count; i++) {
      var cx = rnd(-0.1, 1.1) * w;
      var cy = rnd(-0.1, 1.1) * h;
      var r  = rnd(0.20, 0.52) * span;
      var hu = hue();
      var sa = rnd(72, 96);          // high: these hues cost little light
      var li = rnd(16, 34);          // still low, and the clamp polices it
      var al = rnd(0.42, 0.78);

      var g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0,   "hsla(" + hu + "," + sa + "%," + li + "%," + al + ")");
      g.addColorStop(0.45,"hsla(" + hu + "," + sa + "%," + (li * 0.72) + "%," + (al * 0.42) + ")");
      g.addColorStop(1,   "hsla(" + hu + "," + sa + "%," + (li * 0.5) + "%,0)");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    }

    x.globalCompositeOperation = "source-over";

    /* Measure, then clamp. The buffer is 1/36th of the viewport, so this
       whole pass is a few thousand pixels and runs once. */
    var img, d;
    try { img = x.getImageData(0, 0, w, h); d = img.data; }
    catch (e) { return; }   // never let a canvas restriction break the page

    // the brightest thing the ground can be under the field
    var BR = 8 / 255, BG = 10 / 255, BB = 30 / 255;   // #080a1e
    function lin(v){ return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

    var n = d.length >> 2;
    // keep the drawn alphas: each trial scales from these, not from the
    // previous trial's output
    var a0 = new Float32Array(n);
    for (var k0 = 0; k0 < n; k0++) a0[k0] = d[(k0 << 2) + 3] / 255;

    // every loop counter in here is function-local ON PURPOSE. Sharing one
    // with the caller left peakAt() returning with the counter at n, which
    // ended the search loop after a single pass and scaled the whole field
    // to zero alpha -- a nebula that was painted and then erased.
    function peakAt(k){
      var peak = 0;
      for (var i = 0; i < n; i++) {
        var a = a0[i] * k;
        var p = i << 2;
        var rr = (d[p]     / 255) * a + BR * (1 - a);
        var gg = (d[p + 1] / 255) * a + BG * (1 - a);
        var bb = (d[p + 2] / 255) * a + BB * (1 - a);
        var lum = 0.2126 * lin(rr) + 0.7152 * lin(gg) + 0.0722 * lin(bb);
        if (lum > peak) peak = lum;
      }
      return peak;
    }

    if (peakAt(1) > CEIL) {
      // largest scale whose brightest pixel still sits under the ceiling.
      // 14 halvings resolves k to ~6e-5, far finer than an 8-bit alpha.
      var lo = 0, hi = 1, mid;
      for (var t = 0; t < 14; t++) {
        mid = (lo + hi) / 2;
        if (peakAt(mid) > CEIL) hi = mid; else lo = mid;
      }
      for (var j = 0; j < n; j++) d[(j << 2) + 3] = Math.round(a0[j] * lo * 255);
      x.putImageData(img, 0, 0);
    }
  }

  /* Repainted on resize, and NOT gated on prefers-reduced-motion: the
     field never animates, so there is nothing in it to reduce. A reader
     who asks for less motion still gets the sky, just a still one. */
  paintNebula();
  var nebulaTimer;
  window.addEventListener("resize", function(){
    clearTimeout(nebulaTimer);
    nebulaTimer = setTimeout(paintNebula, 200);
  });

  /* ============================================================
     THE STARFIELD

     Ported from the 'stars' branch of the panel's particle engine in
     cra.user.js, with its constants intact: radius .4-1.2, twinkle
     .02-.07, base alpha .12-.6, alpha = base + .55*|sin(phase)|, a
     white core on anything over .8, and the Midnight meteor every
     220-480 frames. Density there is N*2.4 ("Rolls-Royce headliner");
     here it is scaled off the viewport so a laptop and a phone get the
     same sky rather than the same star count.
     ============================================================ */
  var canvas = document.getElementById("stars");
  if (canvas && canvas.getContext && !reduced) {
    var ctx = canvas.getContext("2d");
    var TAU = Math.PI * 2;
    var rnd = function(a, b){ return a + Math.random() * (b - a); };
    var W = 0, H = 0, dpr = 1, parts = [], meteor = null, meteorAt = 2.5, raf = 0;
    var t = 0, last = 0;   // seconds since start, and the previous timestamp

    function hexA(hex, a){
      var n = parseInt(hex.slice(1), 16);
      return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + Math.max(0, Math.min(1, a)) + ")";
    }

    /* A star, and how it breathes.

       The port from the panel advanced phase once PER FRAME and folded it
       through Math.abs(sin), which had two problems. Per-frame meant a
       120Hz display twinkled at double speed. And abs() halves the period
       AND puts a hard cusp at every minimum, so a star snapped to dark and
       bounced -- a blink, not a twinkle. Between them the sky pulsed every
       0.4-2.6s and read as a switchboard.

       Now: time-based, so every display agrees. Plain sin, so the curve is
       smooth through its minimum. And TWO sines at unrelated periods
       instead of one, so a star never repeats exactly -- the pair drift in
       and out of step and the brightness wanders the way real scintillation
       does, rather than marching.

       On amplitude: an earlier pass held almost every star under a tenth
       to avoid the sky flashing. It went too far the other way -- at a 14%
       swing over 5-18 seconds nothing visibly moved and the field read as
       a still image. Most stars now swing by a third to a half of their
       own brightness, which is a real blink, and the dimmest of them do
       drop to near-invisible at the bottom of a cycle. About one in six
       still holds nearly steady, so the field keeps some depth rather than
       every point in it pumping. */
    function spawn(){
      var steady = Math.random() < 0.17;
      return {
        x: rnd(0, W), y: rnd(0, H),
        r: rnd(.4, 1.2),
        base: rnd(.18, .50),
        amp:  steady ? rnd(.05, .12) : rnd(.24, .46),
        // radians/sec: 2.4-7s and 3.5-11s. Slow enough that nothing
        // strobes, and the beat between two unrelated periods is what
        // keeps a star from ever repeating the same cycle twice.
        f1: rnd(0.90, 2.60), p1: rnd(0, TAU),
        f2: rnd(0.57, 1.80), p2: rnd(0, TAU)
      };
    }

    function size(){
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // one star per ~5200px^2, clamped, so density reads the same at
      // any viewport instead of thinning out on a large display
      var n = Math.max(60, Math.min(340, Math.round((W * H) / 5200)));
      parts = [];
      for (var i = 0; i < n; i++) parts.push(spawn());
    }

    function draw(now){
      // seconds since the last frame, clamped so a backgrounded tab does
      // not resume with one enormous jump
      var dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      t += dt;

      ctx.clearRect(0, 0, W, H);

      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        var s = 0.62 * Math.sin(t * p.f1 + p.p1) + 0.38 * Math.sin(t * p.f2 + p.p2);
        var a = Math.min(1, p.base + p.amp * s);
        ctx.globalAlpha = Math.max(0.04, a);
        ctx.fillStyle = "#eaf1ff";
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
        if (p.r > .8) {
          ctx.fillStyle = hexA("#ffffff", a);
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.55, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      /* the Midnight meteor. Also on seconds now, for the same reason the
         stars are: the panel's 220-480 frames is 3.7-8s at 60Hz but half
         that at 120, and a meteor that crosses twice as fast on a better
         monitor is a bug wearing a plausible face. */
      if (!meteor && t >= meteorAt) {
        var fromLeft = Math.random() < 0.5;
        meteor = {
          x: fromLeft ? rnd(-20, W * 0.3) : rnd(W * 0.7, W + 20),
          y: rnd(-10, H * 0.35),
          vx: (fromLeft ? 1 : -1) * rnd(240, 420),   // px/sec
          vy: rnd(150, 270),
          len: rnd(52, 92),
          life: 1
        };
      }
      if (meteor) {
        meteor.x += meteor.vx * dt;
        meteor.y += meteor.vy * dt;
        meteor.life -= 1.2 * dt;                     // ~0.83s of travel
        // trail along the direction of travel, `len` pixels behind the
        // head. Normalised, so the tail no longer scales with the speed
        // units the way it did when velocity was per-frame.
        var sp = Math.sqrt(meteor.vx * meteor.vx + meteor.vy * meteor.vy) || 1;
        var tx = meteor.x - (meteor.vx / sp) * meteor.len;
        var ty = meteor.y - (meteor.vy / sp) * meteor.len;
        var g = ctx.createLinearGradient(meteor.x, meteor.y, tx, ty);
        g.addColorStop(0, hexA("#ffffff", meteor.life));
        g.addColorStop(.4, hexA("#4f8cff", meteor.life * 0.6));
        g.addColorStop(1, hexA("#4f8cff", 0));
        ctx.strokeStyle = g; ctx.lineWidth = 3; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(meteor.x, meteor.y); ctx.lineTo(tx, ty); ctx.stroke();
        // a soft halo under the head, so the leading point reads as a
        // burning thing rather than as the end of a drawn line
        var halo = ctx.createRadialGradient(meteor.x, meteor.y, 0, meteor.x, meteor.y, 9);
        halo.addColorStop(0, hexA("#ffffff", meteor.life * 0.55));
        halo.addColorStop(1, hexA("#4f8cff", 0));
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(meteor.x, meteor.y, 9, 0, TAU); ctx.fill();
        ctx.fillStyle = hexA("#ffffff", meteor.life);
        ctx.beginPath(); ctx.arc(meteor.x, meteor.y, 2.3, 0, TAU); ctx.fill();
        if (meteor.life <= 0 || meteor.x < -60 || meteor.x > W + 60 || meteor.y > H + 60) {
          meteor = null; meteorAt = t + rnd(5, 15);
        }
      }

      raf = requestAnimationFrame(draw);
    }

    var resizeTimer;
    window.addEventListener("resize", function(){
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(size, 180);
    });

    /* Nothing to draw while the tab is hidden, and a background tab
       repainting a starfield is exactly the kind of thing that shows up
       in somebody's battery report. */
    document.addEventListener("visibilitychange", function(){
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      // `last` is cleared so the first frame back measures dt against
      // itself rather than against however long the tab sat hidden
      else if (!raf) { last = 0; raf = requestAnimationFrame(draw); }
    });

    size();
    raf = requestAnimationFrame(draw);
  }

  /* ---- the meters fill once the panel is actually seen ---- */
  var sheet = document.getElementById("sheet");
  if (sheet) {
    if (!("IntersectionObserver" in window)) {
      sheet.classList.add("lit");
    } else {
      var io = new IntersectionObserver(function(entries, self){
        entries.forEach(function(en){
          if (en.isIntersecting) { en.target.classList.add("lit"); self.unobserve(en.target); }
        });
      }, { threshold: .3 });
      io.observe(sheet);
    }
  }

  /* ---- sections rise as they arrive ---- */
  var risers = document.querySelectorAll(".rise");
  if (!("IntersectionObserver" in window)) {
    risers.forEach(function(el){ el.classList.add("seen"); });
  } else {
    var rio = new IntersectionObserver(function(entries, self){
      entries.forEach(function(en){
        if (en.isIntersecting) { en.target.classList.add("seen"); self.unobserve(en.target); }
      });
    }, { threshold: .12, rootMargin: "0px 0px -40px 0px" });
    risers.forEach(function(el){ rio.observe(el); });
  }

  /* ---- theme swatches ---- */
  var group = document.getElementById("swatches");
  var nameOut = document.getElementById("theme-name");
  if (group) {
    group.addEventListener("click", function(e){
      var btn = e.target.closest("button");
      if (!btn) return;
      group.querySelectorAll("button").forEach(function(b){
        b.setAttribute("aria-pressed", String(b === btn));
      });
      if (nameOut) nameOut.textContent = btn.getAttribute("data-n") || "";
    });
  }

  /* ---- version sync. Unauthenticated by design: this page needs no key,
         so it carries none. Writes only into .cra-version - the assistant's
         number, which is not the loader's. Falls back silently. ---- */
  if (window.fetch) {
    var live = [
      ["https://api.casereview.cc/version",     ".cra-version"],
      ["https://api.casereview.cc/sla/version", ".sla-version"]
    ];
    live.forEach(function(pair){
      fetch(pair[0])
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(meta){
          if (meta && meta.version) {
            document.querySelectorAll(pair[1]).forEach(function(el){
              el.textContent = meta.version;
            });
          }
        })
        .catch(function(){});
    });

    /* ---- loader version sync. The app versions above come from the API,
           but a loader's version lives nowhere except its own
           ==UserScript== block: the Worker never sees these files, they
           are served from this origin by Pages. So read the number out of
           the file itself and the file becomes its own source of truth.

           This exists because the hard-coded number drifted. It sat at
           0.29.0 on this page while users were installing 0.30.1, and
           nothing catches that — a stale version string looks exactly like
           a correct one. Same-origin, so no CORS and no key; fetch() does
           not trigger a userscript install prompt the way navigating to a
           .user.js does. Falls back to the markup silently. ---- */
    var loaders = [
      ["/loader.user.js", ".cra-loader-version"],
      ["/sla.user.js",    ".sla-loader-version"]
    ];
    loaders.forEach(function(pair){
      if (!document.querySelector(pair[1])) return;
      fetch(pair[0])
        .then(function(r){ return r.ok ? r.text() : null; })
        .then(function(src){
          if (!src) return;
          var m = /@version\s+v?([0-9][\w.-]*)/.exec(src);
          if (!m) return;
          document.querySelectorAll(pair[1]).forEach(function(el){
            el.textContent = m[1];
          });
        })
        .catch(function(){});
    });
  }

  /* ---- scroll-spy so the masthead reflects where you are ---- */
  if ("IntersectionObserver" in window) {
    var links = {};
    document.querySelectorAll(".mast nav a").forEach(function(a){
      links[a.getAttribute("href").slice(1)] = a;
    });
    var spy = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        Object.keys(links).forEach(function(k){
          links[k].setAttribute("aria-current", String(k === en.target.id));
        });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    ["score","inside","does","access","install","download"].forEach(function(id){
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }
})();
