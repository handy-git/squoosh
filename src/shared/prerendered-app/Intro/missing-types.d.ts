interface Clipboard {
  read(): Promise<ClipboardItem[]>;
}
