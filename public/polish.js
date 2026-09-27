/* banter polish: @ autocomplete, mention highlight (discord-style), SVG chrome icons.
   Loads alongside the app bundle; hooks via fetch wrap + observers, no bundle edits.
   Message emoji content is untouched (only UI icons go SVG). */
(function () {
  "use strict";

  var SVG_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="M4.5 18.5 10 13l3.5 3.5 3-3 3 3.5"/></svg>';
  var SVG_POLL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 20v-6M12 20V5M18 20v-9"/></svg>';

  var css = document.createElement("style");
  css.textContent =
    ".bmention{color:var(--amber);background:color-mix(in srgb,var(--amber) 16%,transparent);border-radius:4px;padding:0 3px;font-weight:600}" +
    ".bmsg.bmentioned-me{background:color-mix(in srgb,var(--amber) 7%,transparent);border-left:2px solid var(--amber);border-radius:0 6px 6px 0}" +
    ".bacmenu{position:fixed;z-index:80;background:#15171c;border:1px solid #272b34;border-radius:10px;min-width:220px;max-height:264px;overflow:auto;box-shadow:0 10px 34px rgba(0,0,0,.55);padding:4px}" +
    ".bacitem{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer;color:#f2f0ea;font-size:14px}" +
    ".bacitem.on{background:color-mix(in srgb,var(--amber) 15%,transparent)}" +
    ".bacitem .bav{width:22px;height:22px;border-radius:50%;background:#1c1f26;color:var(--amber);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex:none}" +
    ".biconbtn svg{display:block;margin:auto}";
  document.head.appendChild(css);

  /* ---------- SVG icons ---------- */
  function restyleIcons() {
    document.querySelectorAll(".biconbtn").forEach(function (b) {
      if (b.dataset.bsvg) return;
      var t = b.getAttribute("title");
      if (t !== "image" && t !== "poll") return;
      b.dataset.bsvg = "1";
      Array.from(b.childNodes).forEach(function (n) { if (n.nodeType === 3) n.remove(); });
      b.insertAdjacentHTML("afterbegin", t === "image" ? SVG_IMAGE : SVG_POLL);
    });
  }

  /* ---------- state: my name, room members ---------- */
  var myName = null, members = [], knownRooms = [];
  function api(path) {
    return fetch("/api/banter/" + path, { credentials: "same-origin" })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
  }
  api("state").then(function (st) {
    if (st && st.ok) {
      myName = st.name || myName;
      knownRooms = st.rooms || [];
      if (knownRooms.length === 1) primeMembers(knownRooms[0].id);
    }
  });
  function primeMembers(id) {
    api("members?room=" + encodeURIComponent(id)).then(function (d) {
      if (d && d.ok && d.members) members = d.members;
    });
  }
  /* capture the app's own member fetches so we always track the open room */
  var ofetch = window.fetch;
  window.fetch = function () {
    var out = ofetch.apply(this, arguments);
    try {
      var u = typeof arguments[0] === "string" ? arguments[0] : (arguments[0] && arguments[0].url) || "";
      var m = u.match(/\/api\/banter\/members\?room=([^&]+)/);
      if (m) {
        out.then(function (r) {
          r.clone().json().then(function (d) { if (d && d.ok && d.members) members = d.members; }).catch(function () {});
        }).catch(function () {});
      } else if (u.indexOf("/api/banter/state") > -1) {
        out.then(function (r) {
          r.clone().json().then(function (d) { if (d && d.ok && d.name) myName = d.name; }).catch(function () {});
        }).catch(function () {});
      }
    } catch (e) {}
    return out;
  };

  function mentionables() {
    var names = members.map(function (m) { return m.name; }).filter(Boolean);
    if (names.indexOf("goatbot") < 0) names.push("goatbot");
    return names.filter(function (n, i) { return names.indexOf(n) === i && n !== myName; });
  }

  /* ---------- @ autocomplete ---------- */
  var menu = null, menuItems = [], menuSel = 0, menuToken = null;

  function tokenInfo(input) {
    var c = input.selectionStart, up = input.value.slice(0, c);
    var m = up.match(/(^|\s)@([\w-]{0,24})$/);
    if (!m) return null;
    return { start: c - m[2].length - 1, caret: c, q: m[2].toLowerCase() };
  }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } menuToken = null; }
  function renderMenu(input) {
    if (!menu) return;
    menu.innerHTML = "";
    menuItems.forEach(function (name, i) {
      var it = document.createElement("div");
      it.className = "bacitem" + (i === menuSel ? " on" : "");
      it.innerHTML = '<span class="bav">' + name.charAt(0).toUpperCase() + "</span><span>@" + name + "</span>";
      it.addEventListener("mousedown", function (e) { e.preventDefault(); pick(input, name); });
      menu.appendChild(it);
    });
  }
  function openMenu(input) {
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "bacmenu";
      document.body.appendChild(menu);
    }
    var r = input.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.bottom = (window.innerHeight - r.top + 8) + "px";
    renderMenu(input);
  }
  function refreshMenu(input) {
    var t = tokenInfo(input);
    if (!t) { closeMenu(); return; }
    var list = mentionables().filter(function (n) {
      return !t.q || n.toLowerCase().indexOf(t.q) === 0;
    });
    if (!list.length) { closeMenu(); return; }
    menuToken = t; menuItems = list; if (menuSel >= list.length) menuSel = 0;
    openMenu(input);
  }
  function pick(input, name) {
    var t = menuToken || tokenInfo(input);
    if (!t) return closeMenu();
    input.focus();
    input.setRangeText("@" + name + " ", t.start, t.caret, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    closeMenu();
  }

  document.addEventListener("input", function (e) {
    if (e.target && e.target.matches && e.target.matches(".bcomposer input[type='text']")) refreshMenu(e.target);
  });
  document.addEventListener("keydown", function (e) {
    if (!menu || !e.target || !e.target.matches || !e.target.matches(".bcomposer input[type='text']")) return;
    if (e.key === "ArrowDown") { menuSel = (menuSel + 1) % menuItems.length; renderMenu(e.target); e.preventDefault(); }
    else if (e.key === "ArrowUp") { menuSel = (menuSel - 1 + menuItems.length) % menuItems.length; renderMenu(e.target); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "Tab") { pick(e.target, menuItems[menuSel]); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === "Escape") { closeMenu(); e.preventDefault(); }
  }, true);
  document.addEventListener("click", function (e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  });

  /* ---------- mention highlight ---------- */
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function namesRegex() {
    var names = mentionables().concat(myName ? [myName] : []);
    if (!names.length) return null;
    names.sort(function (a, b) { return b.length - a.length; });
    return new RegExp("(^|[^\\w@-])@(" + names.map(esc).join("|") + ")(?![\\w-])", "gi");
  }
  function authorOf(row) {
    var b = row.querySelector(".bmsgmeta b");
    return b ? b.textContent.trim() : "";
  }
  function highlightRow(row) {
    if (row.dataset.bm === "1") return;
    var re = namesRegex();
    if (!re) return;
    var body = row.querySelector(".bmsgbody");
    if (!body) return;
    row.dataset.bm = "1";
    var hitMe = false;
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.parentElement && n.parentElement.closest(".bmsgmeta")) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.indexOf("@") > -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (tn) {
      var frag = document.createDocumentFragment(), last = 0, m;
      re.lastIndex = 0;
      var text = tn.nodeValue, any = false;
      while ((m = re.exec(text))) {
        any = true;
        if (myName && m[2].toLowerCase() === myName.toLowerCase()) hitMe = true;
        frag.appendChild(document.createTextNode(text.slice(last, m.index) + m[1]));
        var span = document.createElement("span");
        span.className = "bmention";
        span.textContent = "@" + m[2];
        frag.appendChild(span);
        last = m.index + m[1].length + m[2].length + 1;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (any) {
        frag.appendChild(document.createTextNode(text.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
      }
    });
    if (hitMe && authorOf(row).toLowerCase() !== (myName || "").toLowerCase()) row.classList.add("bmentioned-me");
  }
  function sweep(root) {
    (root.querySelectorAll ? root.querySelectorAll(".bmsg") : []).forEach(highlightRow);
  }

  var obs = new MutationObserver(function (muts) {
    restyleIcons();
    muts.forEach(function (mu) {
      mu.addedNodes.forEach(function (nd) {
        if (nd.nodeType !== 1) return;
        if (nd.matches && nd.matches(".bmsg")) { delete nd.dataset.bm; highlightRow(nd); }
        else sweep(nd);
      });
    });
  });
  function boot() {
    restyleIcons();
    sweep(document.body);
    obs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();

// brand mark: swap the lead glyph for the shipped svg (themed via --amber)
(function(){
var n=0, SVG='<svg viewBox="0 0 64 64" style="width:1em;height:1em;vertical-align:-0.12em" aria-hidden="true"><mask id="UID"><rect x="15" y="12" width="8" height="40" rx="4" fill="#fff"/><circle cx="34" cy="39" r="13" fill="#fff"/><path d="M28 50 L13 57 L21 43 Z" fill="#fff"/><circle cx="34" cy="39" r="5" fill="#000"/></mask><rect width="64" height="64" fill="var(--amber,#ffa028)" mask="url(#UID)"/></svg>';
function run(){
  document.querySelectorAll('.bsidehead, span.bmark').forEach(function(h){
    if (h.dataset.bmarked) return;
    var before = h.innerHTML, after = before;
    n++;
    var tagged = SVG.split('UID').join('bm'+n);
    after = before.replace('>∿<', '>'+tagged+'<');
    if (after === before) after = before.replace(/^(\s*)∿/, function(m,p){ return p+tagged; });
    if (after !== before) { h.innerHTML = after; h.dataset.bmarked = '1'; }
  });
}
function boot(){ run(); new MutationObserver(run).observe(document.body,{childList:true,subtree:true}); }
if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
