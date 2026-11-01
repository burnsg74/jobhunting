<script>
  import { Editor } from "@tiptap/core";
  import { extensions } from "../lib/tiptap.js";

  let { value = "" } = $props();

  // Read-only render through the same schema as the editor. Re-renders when `value` changes.
  function render(element) {
    const editor = new Editor({
      element,
      extensions: extensions({ editable: false }),
      editable: false,
      content: value,
      contentType: "markdown",
    });
    return () => editor.destroy();
  }
</script>

<div class="md" {@attach render}></div>
