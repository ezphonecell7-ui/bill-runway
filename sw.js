/* Bill Runway service worker - offline shell + daily bill check. */
var CACHE = "bill-runway-v3";
var STATE_CACHE = "bill-runway-state";
var STATE_KEY = "./__state.json";
var ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return (k === CACHE || k === STATE_CACHE) ? null : caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  if(new URL(req.url).origin !== self.location.origin) return;
  if(req.url.indexOf("__state.json") !== -1) return;

  if(req.mode === "navigate"){
    e.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put("./index.html", copy); });
        return res;
      }).catch(function(){
        return caches.match("./index.html").then(function(hit){
          return hit || caches.match("./");
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function(hit){
      var net = fetch(req).then(function(res){
        if(res && res.status === 200){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(req, copy); });
        }
        return res;
      }).catch(function(){ return hit; });
      return hit || net;
    })
  );
});

/* ---------- date maths (mirrors the page) ---------- */
var DAY = 86400000;
var FREQ = {
  weekly:      {days:7},
  biweekly:    {days:14},
  semimonthly: {semi:true},
  fourweekly:  {days:28},
  monthly:     {months:1},
  bimonthly:   {months:2},
  quarterly:   {months:3},
  semiannual:  {months:6},
  yearly:      {months:12}
};
function parseD(s){
  if(!s) return null;
  var p = String(s).split("-");
  var d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]));
  return isNaN(d.getTime()) ? null : d;
}
function addDays(d,n){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()+n); }
function today(){ var n=new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function lastDay(y,m){ return new Date(y,m+1,0).getDate(); }
function monthStep(a,k,day){
  var y=a.getFullYear(), m=a.getMonth()+k;
  return new Date(y,m,Math.min(day,lastDay(y,m)));
}
function semiDays(b){
  var d1 = Number(b.day1) || 1, d2 = Number(b.day2) || 15;
  if(d1 === d2) d2 = (d1 === 15 ? 1 : 15);
  return d1 < d2 ? [d1,d2] : [d2,d1];
}
function semiOn(y,m,day){ return new Date(y,m,Math.min(day,lastDay(y,m))); }
function nextDue(b, from){
  var f = FREQ[b.freq] || FREQ.monthly;
  if(f.semi){
    var ds = semiDays(b), y = from.getFullYear(), m = from.getMonth();
    for(var i=0;i<400;i++){
      for(var j=0;j<2;j++){
        var c = semiOn(y, m+i, ds[j]);
        if(c >= from) return c;
      }
    }
    return null;
  }
  var a = parseD(b.anchor);
  if(!a) return null;
  if(f.days){
    var diff = Math.round((from - a)/DAY);
    var k = Math.max(0, Math.ceil(diff/f.days));
    return addDays(a, k*f.days);
  }
  var day = a.getDate();
  var md = (from.getFullYear()-a.getFullYear())*12 + (from.getMonth()-a.getMonth());
  var k2 = Math.max(0, md - f.months);
  k2 = k2 - (k2 % f.months);
  var d = monthStep(a,k2,day), guard = 0;
  while(d < from && guard++ < 700){ k2 += f.months; d = monthStep(a,k2,day); }
  return d;
}
function money(n){
  return "$" + (Math.round(n*100)/100).toLocaleString(undefined,
    {minimumFractionDigits:2, maximumFractionDigits:2});
}

function dueSoon(state){
  var t = today();
  var window_ = Number(state.remindDays) || 3;
  var hits = [];
  (state.bills || []).forEach(function(b){
    if(b.paused) return;
    var from;
    if(b.paidThrough){
      var pt = parseD(b.paidThrough);
      from = pt ? addDays(pt,1) : t;
    } else {
      from = parseD(b.anchor) || t;
    }
    var due = nextDue(b, from);
    if(!due) return;
    var left = Math.round((due - t)/DAY);
    if(left <= window_) hits.push({name:b.name, amount:Number(b.amount)||0, left:left, autopay:!!b.autopay});
  });
  hits.sort(function(x,y){ return x.left - y.left; });
  return hits;
}

function buildMessage(hits){
  var parts = hits.slice(0,3).map(function(h){
    var when = h.left < 0 ? Math.abs(h.left) + "d overdue"
      : h.left === 0 ? "today" : "in " + h.left + "d";
    return h.name + " " + money(h.amount) + " " + when + (h.autopay ? " (auto)" : "");
  });
  if(hits.length > 3) parts.push("+" + (hits.length-3) + " more");
  return parts.join(" · ");
}

function readState(){
  return caches.open(STATE_CACHE).then(function(c){
    return c.match(STATE_KEY);
  }).then(function(res){
    return res ? res.json() : null;
  }).catch(function(){ return null; });
}
function markNotified(stamp){
  return caches.open(STATE_CACHE).then(function(c){
    return c.put("./__notified.json", new Response(JSON.stringify({on:stamp})));
  }).catch(function(){});
}
function lastNotified(){
  return caches.open(STATE_CACHE).then(function(c){
    return c.match("./__notified.json");
  }).then(function(r){ return r ? r.json() : null; })
   .then(function(j){ return j ? j.on : null; })
   .catch(function(){ return null; });
}

function runCheck(){
  var t = today();
  var stamp = t.getFullYear()+"-"+(t.getMonth()+1)+"-"+t.getDate();
  return Promise.all([readState(), lastNotified()]).then(function(r){
    var state = r[0], last = r[1];
    if(!state) return;
    if(last === stamp) return;
    var hits = dueSoon(state);
    if(!hits.length) return;
    var title = hits.length === 1 ? "1 bill needs attention"
      : hits.length + " bills need attention";
    return self.registration.showNotification(title, {
      body: buildMessage(hits),
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: "bill-runway-due",
      renotify: true,
      requireInteraction: false,
      data: {url: "./"}
    }).then(function(){ return markNotified(stamp); });
  });
}

self.addEventListener("periodicsync", function(e){
  if(e.tag === "bill-check") e.waitUntil(runCheck());
});
self.addEventListener("sync", function(e){
  if(e.tag === "bill-check") e.waitUntil(runCheck());
});
self.addEventListener("message", function(e){
  if(e.data && e.data.type === "check-now") e.waitUntil(runCheck());
});

self.addEventListener("notificationclick", function(e){
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({type:"window", includeUncontrolled:true}).then(function(list){
      for(var i=0;i<list.length;i++){
        if(list[i].url.indexOf(self.registration.scope) === 0 && "focus" in list[i]){
          return list[i].focus();
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
