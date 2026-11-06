"use strict";

if (new URLSearchParams(window.location.search).has("workspace")) {
  document.documentElement.classList.add("workspace-embed");
}
