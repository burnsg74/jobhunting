// One Tiptap schema for everything: the editor, the read-only log entries, and rendered postings.
// No raw HTML anywhere: content goes markdown -> schema nodes -> DOM, and back to markdown on save.
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";

export function extensions({ editable }) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: !editable,
        autolink: true,
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      },
    }),
    Markdown,
  ];
}
