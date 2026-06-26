import blessed from "blessed";
const screen = blessed.screen({ smartCSR: true });
const box = blessed.box({ content: "hello" });
screen.append(box);
console.error("ok:", typeof blessed.screen, typeof box.setContent, typeof blessed.list);
screen.destroy();
