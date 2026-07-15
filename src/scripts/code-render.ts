/* =========================================================================
   Syntax highlighting. Kept in its own module so highlight.js (~42KB min)
   loads on demand via dynamic import — it's only needed once a result
   finishes, never at page load.
   ========================================================================= */
import hljs from "highlight.js/lib/core";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import beautify from "js-beautify";

// css/javascript act as sublanguages of xml for embedded <style>/<script>.
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);

export function formatCode(code: string): string {
  try {
    return beautify.html(code, {
      indent_size: 2,
      wrap_line_length: 0,
      preserve_newlines: true,
      max_preserve_newlines: 1,
      end_with_newline: false,
    });
  } catch {
    return code;
  }
}

export function highlightCode(code: string): string {
  try {
    return hljs.highlight(code, { language: "xml" }).value;
  } catch {
    return code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  }
}
