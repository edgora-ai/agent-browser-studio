(function(){
  var out = {};
  function d(o, k){
    try { var x = Object.getOwnPropertyDescriptor(o, k); if (!x) return "none"; return (("get" in x) ? "getter:" + String(x.get).slice(0, 22) : "data:" + JSON.stringify(x.value).slice(0, 30)) + " cfg=" + x.configurable + " enum=" + x.enumerable + " own=" + Object.prototype.hasOwnProperty.call(o, k); } catch (e) { return "err"; }
  }
  out.win_screenX = d(window, "screenX");
  out.win_screenY = d(window, "screenY");
  out.win_outerWidth = d(window, "outerWidth");
  out.win_innerWidth = d(window, "innerWidth");
  out.win_devicePixelRatio = d(window, "devicePixelRatio");
  out.win_outerHeight = d(window, "outerHeight");
  out.win_innerHeight = d(window, "innerHeight");
  out.screen_width = d(Screen.prototype, "width");
  out.screen_availWidth = d(Screen.prototype, "availWidth");
  out.nav_platform = d(Navigator.prototype, "platform");
  out.nav_language = d(Navigator.prototype, "language");
  out.nav_languages = d(Navigator.prototype, "languages");
  out.nav_oscpu = d(Navigator.prototype, "oscpu");
  out.nav_appVersion = d(Navigator.prototype, "appVersion");
  out.nav_webdriver = d(Navigator.prototype, "webdriver");
  out.nav_hardwareConcurrency = d(Navigator.prototype, "hardwareConcurrency");
  out.nav_maxTouchPoints = d(Navigator.prototype, "maxTouchPoints");
  out.nav_userAgent = d(Navigator.prototype, "userAgent");
  out.date_getTZOffset = d(Date.prototype, "getTimezoneOffset");
  out.ctx_measureText = d(CanvasRenderingContext2D.prototype, "measureText");
  out.canvas_getContext = d(HTMLCanvasElement.prototype, "getContext");
  out.ffs_check = d(FontFaceSet.prototype, "check");
  out.ffs_match = d(FontFaceSet.prototype, "match");
  out.intl_dtf = d(Intl, "DateTimeFormat");
  out.intl_nf = d(Intl, "NumberFormat");
  out.media_enum = d(navigator.mediaDevices && navigator.mediaDevices.constructor.prototype, "enumerateDevices");
  out.media_own = Object.prototype.hasOwnProperty.call(navigator.mediaDevices || {}, "enumerateDevices");
  out.speech_getVoices = d((typeof speechSynthesis !== "undefined" && speechSynthesis.constructor) ? speechSynthesis.constructor.prototype : {}, "getVoices");
  out.speech_own = Object.prototype.hasOwnProperty.call(typeof speechSynthesis !== "undefined" ? speechSynthesis : {}, "getVoices");
  out.storage_estimate = d(navigator.storage && navigator.storage.constructor.prototype, "estimate");
  out.storage_own = Object.prototype.hasOwnProperty.call(navigator.storage || {}, "estimate");
  out.geo_getCurrent = d(navigator.geolocation && navigator.geolocation.constructor.prototype, "getCurrentPosition");
  out.geo_own = Object.prototype.hasOwnProperty.call(navigator.geolocation || {}, "getCurrentPosition");
  out.fnproto_toString = String(Function.prototype.toString).slice(0, 60);
  out.fnproto_toString_own = String(Object.getOwnPropertyDescriptor(Function.prototype, "toString").value).slice(0, 40);
  out.fnproto_toSource = String(Function.prototype.toSource).slice(0, 60);
  return out;
})()
