<script>
  import { Editor } from "@tiptap/core";
  import { untrack } from "svelte";
  import { extensions } from "../lib/tiptap.js";

  // Tall WYSIWYG editor that stores markdown. Cmd/Ctrl+Enter calls onsubmit.
  let { value = "", onsubmit = () => {}, autofocus = false } = $props();

  let editor = $state.raw(null);
  let tick = $state(0); // bumps on every transaction so toolbar state re-reads

  /** Current content as markdown. */
  export function getMarkdown() {
    return editor ? editor.getMarkdown().trim() : "";
  }

  export function clear() {
    editor?.commands.clearContent();
  }

  // Mounted once. The initial `value` is read untracked so later prop changes never rebuild the editor.
  function mount(element) {
    const instance = new Editor({
      element,
      extensions: extensions({ editable: true }),
      content: untrack(() => value),
      contentType: "markdown",
      autofocus: untrack(() => autofocus),
      editorProps: {
        attributes: { class: "md editor-surface", "aria-label": "Message" },
        handleKeyDown: (_view, event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onsubmit();
            return true;
          }
          return false;
        },
      },
      onTransaction: () => tick++,
    });
    editor = instance;
    return () => {
      instance.destroy();
      editor = null;
    };
  }

  const active = (name, attrs) => {
    void tick;
    return editor ? editor.isActive(name, attrs) : false;
  };

  function setLink() {
    if (!editor) return;
    const previous = editor.getAttributes("link").href ?? "";
    const input = window.prompt("Link URL (empty to remove)", previous);
    if (input === null) return;
    const href = input.trim();
    if (!href) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  const buttons = [
    { label: "H2", title: "Heading 2", name: "heading", attrs: { level: 2 }, run: (c) => c.toggleHeading({ level: 2 }) },
    { label: "H3", title: "Heading 3", name: "heading", attrs: { level: 3 }, run: (c) => c.toggleHeading({ level: 3 }) },
    { label: "B", title: "Bold", name: "bold", run: (c) => c.toggleBold(), style: "font-weight:700" },
    { label: "I", title: "Italic", name: "italic", run: (c) => c.toggleItalic(), style: "font-style:italic" },
    { label: "Link", title: "Link", name: "link", run: null },
    { label: "• List", title: "Bullet list", name: "bulletList", run: (c) => c.toggleBulletList() },
    { label: "1. List", title: "Numbered list", name: "orderedList", run: (c) => c.toggleOrderedList() },
    { label: "Quote", title: "Quote", name: "blockquote", run: (c) => c.toggleBlockquote() },
    { label: "Code", title: "Code block", name: "codeBlock", run: (c) => c.toggleCodeBlock() },
  ];
</script>

<div class="editor">
  <div class="toolbar" role="toolbar" aria-label="Formatting">
    {#each buttons as b (b.label)}
      <button
        type="button"
        title={b.title}
        class={{ on: active(b.name, b.attrs) }}
        style={b.style}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => (b.run ? b.run(editor.chain().focus()).run() : setLink())}
      >
        {b.label}
      </button>
    {/each}
  </div>
  <div class="surface" {@attach mount}></div>
</div>

<style>
  .editor {
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }

  .toolbar button {
    padding: 3px 9px;
    font-size: 12px;
  }

  .toolbar button.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .surface {
    padding: 8px 12px;
  }

  .surface :global(.editor-surface) {
    min-height: 260px;
    outline: none;
  }
</style>
