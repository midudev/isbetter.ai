import { bind } from "cuelume";

const DISMISS =
  "#key-cancel, #history-close, #history-clear, [data-remove], [data-del]";
const EXPAND =
  "#key-btn, #history-btn, #run-btn, #reveal-models-btn, [data-openkeys], [data-action='open']";
const TOGGLE =
  "#add-model-btn, #sys-toggle, #scroll-link-btn, #blind-mode-btn, .view-tab, [data-provtab], [data-add]";
const SPARKLE =
  "#sys-reset, #rerun-all-btn, [data-prompt-example], [data-action='rerun'], [data-action='reload-preview']";
const SUCCESS = "#key-save, [data-action='copy']";

function setCue(element: Element, attribute: string, sound?: string) {
  if (!element.hasAttribute(attribute)) element.setAttribute(attribute, sound || "");
}

function decorate(element: Element) {
  const control = element.closest("button, a");
  if (!control || control.matches(":disabled")) return;

  if (control.matches("a")) {
    setCue(control, "data-cuelume-hover", "tick");
    setCue(control, "data-cuelume-toggle", "release");
    return;
  }

  if (control.matches(DISMISS)) {
    setCue(control, "data-cuelume-toggle", "droplet");
  } else if (control.matches(EXPAND)) {
    setCue(control, "data-cuelume-toggle", "bloom");
  } else if (control.matches(TOGGLE)) {
    setCue(control, "data-cuelume-toggle", "toggle");
  } else if (control.matches(SPARKLE)) {
    setCue(control, "data-cuelume-toggle", "sparkle");
  } else if (!control.matches(SUCCESS)) {
    setCue(control, "data-cuelume-press", "press");
    setCue(control, "data-cuelume-release", "release");
  }
}

export function initSounds() {
  if (typeof document === "undefined") return;

  // Decorate lazily so controls rendered later by the battle scripts are
  // covered without a MutationObserver. These capture listeners run before
  // Cuelume's delegated listeners for the same event.
  const decorateTarget = (event: Event) => {
    if (event.target instanceof Element) decorate(event.target);
  };
  document.addEventListener("pointerenter", decorateTarget, true);
  document.addEventListener("pointerdown", decorateTarget, true);
  document.addEventListener("click", decorateTarget, true);
  bind();
}
