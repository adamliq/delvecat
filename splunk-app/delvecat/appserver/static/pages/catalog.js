// The DelveCat page. Splunk's page templates load pages/<view>.js as a classic script;
// the app itself is an ES module (build/delvecat.js), so this imports it with its styles.
(function () {
  var self = document.currentScript && document.currentScript.src;
  var base = self ? new URL("../build/", self).href : "../build/";
  var css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = base + "delvecat.css";
  document.head.appendChild(css);
  import(base + "delvecat.js").catch(function (err) {
    document.body.textContent = "DelveCat could not load: " + err;
  });
})();
