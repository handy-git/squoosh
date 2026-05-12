import { h, Component } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import {
  blobToImg,
  blobToText,
  builtinDecode,
  sniffMimeType,
  canDecodeImageType,
  abortable,
  assertSignal,
  ImageMimeTypes,
} from '../util';
import {
  PreprocessorState,
  ProcessorState,
  EncoderState,
  encoderMap,
  defaultPreprocessorState,
  defaultProcessorState,
  EncoderType,
  EncoderOptions,
} from '../feature-meta';
import Output from './Output';
import Options from './Options';
import ResultCache from './result-cache';
import { cleanMerge, cleanSet } from '../util/clean-modify';
import './custom-els/MultiPanel';
import Results from './Results';
import prettyBytes from './Results/pretty-bytes';
import WorkerBridge from '../worker-bridge';
import { resize } from 'features/processors/resize/client';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import { drawableToImageData } from '../util/canvas';
import { linkRef } from 'shared/prerendered-app/util';

export type OutputType = EncoderType | 'identity';

export interface SourceImage {
  file: File;
  decoded: ImageData;
  preprocessed: ImageData;
  vectorImage?: HTMLImageElement;
}

interface SideSettings {
  processorState: ProcessorState;
  encoderState?: EncoderState;
}

interface Side {
  processed?: ImageData;
  file?: File;
  downloadUrl?: string;
  data?: ImageData;
  latestSettings: SideSettings;
  encodedSettings?: SideSettings;
  loading: boolean;
}

interface Props {
  file: File;
  files: File[];
  selectedFileIndex: number;
  showSnack: SnackBarElement['showSnackbar'];
  onBack: () => void;
  onSelectFile: (index: number) => void;
  onAddFiles: (files: File[]) => void;
}

interface State {
  source?: SourceImage;
  sides: [Side, Side];
  /** Source image load */
  loading: boolean;
  mobileView: boolean;
  preprocessorState: PreprocessorState;
  encodedPreprocessorState?: PreprocessorState;
  selectedFileIndexes: number[];
  expandedTreePaths: string[];
  batchProcessing: boolean;
  batchProgress?: string;
}

interface MainJob {
  file: File;
  preprocessorState: PreprocessorState;
}

interface SideJob {
  processorState: ProcessorState;
  encoderState?: EncoderState;
}

interface LoadingFileInfo {
  loading: boolean;
  filename?: string;
}

interface TreeRow {
  type: 'dir' | 'file';
  path: string;
  label: string;
  depth: number;
  fileIndex?: number;
  fileIndexes: number[];
}

interface ZipEntry {
  path: string;
  file: File;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function filePath(file: File): string {
  return ((file as any).webkitRelativePath || file.name).replace(/^\/+/, '');
}

function isImageFile(file: File): boolean {
  return (
    file.type.startsWith('image/') ||
    /\.(avif|gif|jpe?g|jxl|png|qoi|svg|webp)$/i.test(file.name)
  );
}

async function collectDirectoryFiles(
  directoryHandle: any,
  directoryPath = directoryHandle.name,
): Promise<File[]> {
  const files: File[] = [];

  for await (const [name, handle] of directoryHandle.entries()) {
    const path = `${directoryPath}/${name}`;
    if (handle.kind === 'directory') {
      files.push(...(await collectDirectoryFiles(handle, path)));
      continue;
    }

    const file = await handle.getFile();
    if (!isImageFile(file)) continue;
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: path,
    });
    files.push(file);
  }

  return files;
}

function replaceFileExtension(path: string, extension: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  if (lastDot > lastSlash) return path.slice(0, lastDot + 1) + extension;
  return `${path}.${extension}`;
}

function uniquePath(path: string, usedPaths: Set<string>): string {
  if (!usedPaths.has(path)) {
    usedPaths.add(path);
    return path;
  }

  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash + 1);
  const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const lastDot = filename.lastIndexOf('.');
  const name = lastDot === -1 ? filename : filename.slice(0, lastDot);
  const extension = lastDot === -1 ? '' : filename.slice(lastDot);

  let index = 2;
  while (true) {
    const nextPath = `${dir}${name}-${index}${extension}`;
    if (!usedPaths.has(nextPath)) {
      usedPaths.add(nextPath);
      return nextPath;
    }
    index++;
  }
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

async function createZip(entries: ZipEntry[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const fileBytes = new Uint8Array(await entry.file.arrayBuffer());
    const checksum = crc32(fileBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const centralHeader = new Uint8Array(46 + nameBytes.length);

    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, dosTime);
    writeUint16(localHeader, 12, dosDate);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, fileBytes.length);
    writeUint32(localHeader, 22, fileBytes.length);
    writeUint16(localHeader, 26, nameBytes.length);
    localHeader.set(nameBytes, 30);

    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, dosTime);
    writeUint16(centralHeader, 14, dosDate);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, fileBytes.length);
    writeUint32(centralHeader, 24, fileBytes.length);
    writeUint16(centralHeader, 28, nameBytes.length);
    writeUint32(centralHeader, 42, offset);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, fileBytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + fileBytes.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce(
    (total, part) => total + part.length,
    0,
  );
  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, 0x06054b50);
  writeUint16(endRecord, 8, entries.length);
  writeUint16(endRecord, 10, entries.length);
  writeUint32(endRecord, 12, centralSize);
  writeUint32(endRecord, 16, centralOffset);

  return new Blob([...localParts, ...centralParts, endRecord], {
    type: 'application/zip',
  });
}

function buildTreeRows(files: File[]): TreeRow[] {
  const dirs = new Map<string, TreeRow>();
  const rows: TreeRow[] = [];

  files.forEach((file, fileIndex) => {
    const parts = filePath(file).split('/').filter(Boolean);
    let dirPath = '';
    parts.slice(0, -1).forEach((part, depth) => {
      dirPath = dirPath ? `${dirPath}/${part}` : part;
      const existing = dirs.get(dirPath);
      if (existing) {
        existing.fileIndexes.push(fileIndex);
        return;
      }
      const row: TreeRow = {
        type: 'dir',
        path: dirPath,
        label: part,
        depth,
        fileIndexes: [fileIndex],
      };
      dirs.set(dirPath, row);
      rows.push(row);
    });
    rows.push({
      type: 'file',
      path: filePath(file),
      label: parts[parts.length - 1] || file.name,
      depth: Math.max(0, parts.length - 1),
      fileIndex,
      fileIndexes: [fileIndex],
    });
  });

  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function initiallyExpandedTreePaths(files: File[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const parts = filePath(file).split('/').filter(Boolean);
    if (parts.length > 1) paths.add(parts[0]);
  }
  return Array.from(paths);
}

function visibleTreeRows(rows: TreeRow[], expandedPaths: string[]): TreeRow[] {
  const expanded = new Set(expandedPaths);
  return rows.filter((row) => {
    const parents = row.path.split('/').slice(0, -1);
    let parentPath = '';
    for (const parent of parents) {
      parentPath = parentPath ? `${parentPath}/${parent}` : parent;
      if (!expanded.has(parentPath)) return false;
    }
    return true;
  });
}

async function decodeImage(
  signal: AbortSignal,
  blob: Blob,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  const mimeType = await abortable(signal, sniffMimeType(blob));
  const canDecode = await abortable(signal, canDecodeImageType(mimeType));

  try {
    if (!canDecode) {
      if (mimeType === 'image/avif') {
        return await workerBridge.avifDecode(signal, blob);
      }
      if (mimeType === 'image/webp') {
        return await workerBridge.webpDecode(signal, blob);
      }
      if (mimeType === 'image/jxl') {
        return await workerBridge.jxlDecode(signal, blob);
      }
      if (mimeType === 'image/webp2') {
        return await workerBridge.wp2Decode(signal, blob);
      }
      if (mimeType === 'image/qoi') {
        return await workerBridge.qoiDecode(signal, blob);
      }
    }
    // Otherwise fall through and try built-in decoding for a laugh.
    return await builtinDecode(signal, blob);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    console.log(err);
    throw Error('无法解码图片');
  }
}

async function preprocessImage(
  signal: AbortSignal,
  data: ImageData,
  preprocessorState: PreprocessorState,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  let processedData = data;

  if (preprocessorState.rotate.rotate !== 0) {
    processedData = await workerBridge.rotate(
      signal,
      processedData,
      preprocessorState.rotate,
    );
  }

  return processedData;
}

async function processImage(
  signal: AbortSignal,
  source: SourceImage,
  processorState: ProcessorState,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  let result = source.preprocessed;

  if (processorState.resize.enabled) {
    result = await resize(signal, source, processorState.resize, workerBridge);
  }
  if (processorState.quantize.enabled) {
    result = await workerBridge.quantize(
      signal,
      result,
      processorState.quantize,
    );
  }
  return result;
}

async function compressImage(
  signal: AbortSignal,
  image: ImageData,
  encodeData: EncoderState,
  sourceFilename: string,
  workerBridge: WorkerBridge,
): Promise<File> {
  assertSignal(signal);

  const encoder = encoderMap[encodeData.type];
  const compressedData = await encoder.encode(
    signal,
    workerBridge,
    image,
    // The type of encodeData.options is enforced via the previous line
    encodeData.options as any,
  );

  // This type ensures the image mimetype is consistent with our mimetype sniffer
  const type: ImageMimeTypes = encoder.meta.mimeType;

  return new File(
    [compressedData],
    sourceFilename.replace(/.[^.]*$/, `.${encoder.meta.extension}`),
    { type },
  );
}

function stateForNewSourceData(state: State): State {
  let newState = { ...state };

  for (const i of [0, 1]) {
    // Ditch previous encodings
    const downloadUrl = state.sides[i].downloadUrl;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);

    newState = cleanMerge(state, `sides.${i}`, {
      preprocessed: undefined,
      file: undefined,
      downloadUrl: undefined,
      data: undefined,
      encodedSettings: undefined,
    });
  }

  return newState;
}

async function processSvg(
  signal: AbortSignal,
  blob: Blob,
): Promise<HTMLImageElement> {
  assertSignal(signal);
  // Firefox throws if you try to draw an SVG to canvas that doesn't have width/height.
  // In Chrome it loads, but drawImage behaves weirdly.
  // This function sets width/height if it isn't already set.
  const parser = new DOMParser();
  const text = await abortable(signal, blobToText(blob));
  const document = parser.parseFromString(text, 'image/svg+xml');
  const svg = document.documentElement!;

  if (svg.hasAttribute('width') && svg.hasAttribute('height')) {
    return blobToImg(blob);
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) throw Error('SVG 必须包含 width/height 或 viewBox');

  const viewboxParts = viewBox.split(/\s+/);
  svg.setAttribute('width', viewboxParts[2]);
  svg.setAttribute('height', viewboxParts[3]);

  const serializer = new XMLSerializer();
  const newSource = serializer.serializeToString(document);
  return abortable(
    signal,
    blobToImg(new Blob([newSource], { type: 'image/svg+xml' })),
  );
}

/**
 * If two processors are disabled, they're considered equivalent, otherwise
 * equivalence is based on ===
 */
function processorStateEquivalent(a: ProcessorState, b: ProcessorState) {
  // Quick exit
  if (a === b) return true;

  // All processors have the same keys
  for (const key of Object.keys(a) as Array<keyof ProcessorState>) {
    // If both processors are disabled, they're the same.
    if (!a[key].enabled && !b[key].enabled) continue;
    if (a !== b) return false;
  }

  return true;
}

const loadingIndicator = '⏳ ';

const originalDocumentTitle = document.title;

function updateDocumentTitle(loadingFileInfo: LoadingFileInfo): void {
  const { loading, filename } = loadingFileInfo;
  let title = '';
  if (loading) title += loadingIndicator;
  if (filename) title += filename + ' - ';
  title += originalDocumentTitle;
  document.title = title;
}

export default class Compress extends Component<Props, State> {
  widthQuery = window.matchMedia('(max-width: 599px)');

  state: State = {
    source: undefined,
    loading: false,
    preprocessorState: defaultPreprocessorState,
    sides: [
      {
        latestSettings: {
          processorState: defaultProcessorState,
          encoderState: undefined,
        },
        loading: false,
      },
      {
        latestSettings: {
          processorState: defaultProcessorState,
          encoderState: {
            type: 'webP',
            options: encoderMap.webP.meta.defaultOptions,
          },
        },
        loading: false,
      },
    ],
    mobileView: this.widthQuery.matches,
    selectedFileIndexes: this.props.files.map((_, index) => index),
    expandedTreePaths: initiallyExpandedTreePaths(this.props.files),
    batchProcessing: false,
  };

  private readonly encodeCache = new ResultCache();
  // One for each side
  private readonly workerBridges = [new WorkerBridge(), new WorkerBridge()];
  /** Abort controller for actions that impact both sites, like source image decoding and preprocessing */
  private mainAbortController = new AbortController();
  // And again one for each side
  private sideAbortControllers = [new AbortController(), new AbortController()];
  /** For debouncing calls to updateImage for each side. */
  private updateImageTimeout?: number;
  private addFilesInput?: HTMLInputElement;
  private addDirectoryInput?: HTMLInputElement;

  constructor(props: Props) {
    super(props);
    this.widthQuery.addListener(this.onMobileWidthChange);
    this.sourceFile = props.file;
    this.queueUpdateImage({ immediate: true });

    import('../sw-bridge').then(({ mainAppLoaded }) => mainAppLoaded());
  }

  private onMobileWidthChange = () => {
    this.setState({ mobileView: this.widthQuery.matches });
  };

  private onEncoderTypeChange = (index: 0 | 1, newType: OutputType): void => {
    this.setState({
      sides: cleanSet(
        this.state.sides,
        `${index}.latestSettings.encoderState`,
        newType === 'identity'
          ? undefined
          : {
              type: newType,
              options: encoderMap[newType].meta.defaultOptions,
            },
      ),
    });
  };

  private onProcessorOptionsChange = (
    index: 0 | 1,
    options: ProcessorState,
  ): void => {
    this.setState({
      sides: cleanSet(
        this.state.sides,
        `${index}.latestSettings.processorState`,
        options,
      ),
    });
  };

  private onEncoderOptionsChange = (
    index: 0 | 1,
    options: EncoderOptions,
  ): void => {
    this.setState({
      sides: cleanSet(
        this.state.sides,
        `${index}.latestSettings.encoderState.options`,
        options,
      ),
    });
  };

  componentWillReceiveProps(nextProps: Props): void {
    if (nextProps.files !== this.props.files) {
      this.setState({
        selectedFileIndexes: nextProps.files.map((_, index) => index),
        expandedTreePaths: initiallyExpandedTreePaths(nextProps.files),
      });
    }
    if (nextProps.file !== this.props.file) {
      this.sourceFile = nextProps.file;
      this.queueUpdateImage({ immediate: true });
    }
  }

  componentWillUnmount(): void {
    updateDocumentTitle({ loading: false });
    this.widthQuery.removeListener(this.onMobileWidthChange);
    this.mainAbortController.abort();
    for (const controller of this.sideAbortControllers) {
      controller.abort();
    }
  }

  componentDidUpdate(prevProps: Props, prevState: State): void {
    const wasLoading =
      prevState.loading ||
      prevState.sides[0].loading ||
      prevState.sides[1].loading;
    const isLoading =
      this.state.loading ||
      this.state.sides[0].loading ||
      this.state.sides[1].loading;
    const sourceChanged = prevState.source !== this.state.source;
    if (wasLoading !== isLoading || sourceChanged) {
      updateDocumentTitle({
        loading: isLoading,
        filename: this.state.source?.file.name,
      });
    }
    this.queueUpdateImage();
  }

  private onPreprocessorChange = async (
    preprocessorState: PreprocessorState,
  ): Promise<void> => {
    const source = this.state.source;
    if (!source) return;

    const oldRotate = this.state.preprocessorState.rotate.rotate;
    const newRotate = preprocessorState.rotate.rotate;
    const orientationChanged = oldRotate % 180 !== newRotate % 180;

    this.setState((state) => ({
      loading: true,
      preprocessorState,
      // Flip resize values if orientation has changed
      sides: !orientationChanged
        ? state.sides
        : (state.sides.map((side) => {
            const currentResizeSettings =
              side.latestSettings.processorState.resize;
            const resizeSettings: Partial<ProcessorState['resize']> = {
              width: currentResizeSettings.height,
              height: currentResizeSettings.width,
            };
            return cleanMerge(
              side,
              'latestSettings.processorState.resize',
              resizeSettings,
            );
          }) as [Side, Side]),
    }));
  };

  private onToggleAllFiles = () => {
    const allSelected =
      this.state.selectedFileIndexes.length === this.props.files.length;
    this.setState({
      selectedFileIndexes: allSelected
        ? []
        : this.props.files.map((_, index) => index),
    });
  };

  private onToggleTreeRow = (row: TreeRow) => {
    const current = new Set(this.state.selectedFileIndexes);
    const allSelected = row.fileIndexes.every((index) => current.has(index));

    for (const index of row.fileIndexes) {
      if (allSelected) {
        current.delete(index);
      } else {
        current.add(index);
      }
    }

    this.setState({
      selectedFileIndexes: this.props.files
        .map((_, index) => index)
        .filter((index) => current.has(index)),
    });
  };

  private onToggleTreeDirectory = (path: string) => {
    const expanded = new Set(this.state.expandedTreePaths);
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    this.setState({ expandedTreePaths: Array.from(expanded) });
  };

  private onAddFilesInputChange = (event: Event): void => {
    const fileInput = event.target as HTMLInputElement;
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = '';
    this.props.onAddFiles(files.filter(isImageFile));
  };

  private onOpenAddFilesClick = () => {
    this.addFilesInput!.click();
  };

  private onOpenAddDirectoryClick = async () => {
    const picker = (window as any).showDirectoryPicker;
    if (!picker) {
      this.addDirectoryInput!.setAttribute('webkitdirectory', '');
      this.addDirectoryInput!.click();
      return;
    }

    try {
      const directoryHandle = await picker.call(window);
      const files = await collectDirectoryFiles(directoryHandle);
      if (files.length === 0) {
        await this.props.showSnack('目录中没有可处理的图片');
        return;
      }
      this.props.onAddFiles(files);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      await this.props.showSnack('目录读取失败');
    }
  };

  private getBatchSettings(): SideSettings {
    const rightSettings = this.state.sides[1].latestSettings;
    return {
      processorState: rightSettings.processorState,
      encoderState: rightSettings.encoderState,
    };
  }

  private async processBatchFile(
    signal: AbortSignal,
    file: File,
    settings: SideSettings,
    workerBridge: WorkerBridge,
  ): Promise<File> {
    let decoded: ImageData;
    let vectorImage: HTMLImageElement | undefined;

    if (file.type.startsWith('image/svg+xml')) {
      vectorImage = await processSvg(signal, file);
      decoded = drawableToImageData(vectorImage);
    } else {
      decoded = await decodeImage(signal, file, workerBridge);
    }

    const preprocessed = await preprocessImage(
      signal,
      decoded,
      this.state.preprocessorState,
      workerBridge,
    );
    const source: SourceImage = {
      file,
      decoded,
      preprocessed,
      vectorImage,
    };
    const processed = await processImage(
      signal,
      source,
      settings.processorState,
      workerBridge,
    );

    return compressImage(
      signal,
      processed,
      settings.encoderState!,
      file.name,
      workerBridge,
    );
  }

  private onBatchDownload = async () => {
    const settings = this.getBatchSettings();
    if (!settings.encoderState) {
      await this.props.showSnack('请先在右侧选择压缩格式');
      return;
    }

    const selectedFiles = this.state.selectedFileIndexes.map(
      (index) => this.props.files[index],
    );
    if (selectedFiles.length === 0) {
      await this.props.showSnack('请先选择要批量处理的图片');
      return;
    }

    const signal = new AbortController().signal;
    const workerBridge = new WorkerBridge();
    const entries: ZipEntry[] = [];
    const usedPaths = new Set<string>();
    let failedCount = 0;

    this.setState({
      batchProcessing: true,
      batchProgress: `0/${selectedFiles.length}`,
    });

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        this.setState({
          batchProgress: `${i + 1}/${selectedFiles.length} ${file.name}`,
        });

        try {
          const compressedFile = await this.processBatchFile(
            signal,
            file,
            settings,
            workerBridge,
          );
          const outputPath = replaceFileExtension(
            filePath(file),
            encoderMap[settings.encoderState.type].meta.extension,
          );
          entries.push({
            path: uniquePath(outputPath, usedPaths),
            file: compressedFile,
          });
        } catch (err) {
          failedCount++;
          console.log(err);
        }
      }

      if (entries.length === 0) {
        await this.props.showSnack('批量处理失败，没有可下载的文件');
        return;
      }

      const zipBlob = await createZip(entries);
      const downloadUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `ricepic-batch-${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

      await this.props.showSnack(
        failedCount
          ? `已打包 ${entries.length} 张，失败 ${failedCount} 张`
          : `已打包 ${entries.length} 张图片`,
        { timeout: 3000 },
      );
    } finally {
      this.setState({
        batchProcessing: false,
        batchProgress: undefined,
      });
    }
  };

  /**
   * Debounce the heavy lifting of updateImage.
   * Otherwise, the thrashing causes jank, and sometimes crashes iOS Safari.
   */
  private queueUpdateImage({ immediate }: { immediate?: boolean } = {}): void {
    // Call updateImage after this delay, unless queueUpdateImage is called
    // again, in which case the timeout is reset.
    const delay = 100;

    clearTimeout(this.updateImageTimeout);
    if (immediate) {
      this.updateImage();
    } else {
      this.updateImageTimeout = setTimeout(() => this.updateImage(), delay);
    }
  }

  private sourceFile: File;
  /** The in-progress job for decoding and preprocessing */
  private activeMainJob?: MainJob;
  /** The in-progress job for each side (processing and encoding) */
  private activeSideJobs: [SideJob?, SideJob?] = [undefined, undefined];

  /**
   * Perform image processing.
   *
   * This function is a monster, but I didn't want to break it up, because it
   * never gets partially called. Instead, it looks at the current state, and
   * decides which steps can be skipped, and which can be cached.
   */
  private async updateImage() {
    const currentState = this.state;

    // State of the last completed job, or ongoing job
    const latestMainJobState: Partial<MainJob> = this.activeMainJob || {
      file: currentState.source && currentState.source.file,
      preprocessorState: currentState.encodedPreprocessorState,
    };
    const latestSideJobStates: Partial<SideJob>[] = currentState.sides.map(
      (side, i) =>
        this.activeSideJobs[i] || {
          processorState:
            side.encodedSettings && side.encodedSettings.processorState,
          encoderState:
            side.encodedSettings && side.encodedSettings.encoderState,
        },
    );

    // State for this job
    const mainJobState: MainJob = {
      file: this.sourceFile,
      preprocessorState: currentState.preprocessorState,
    };
    const sideJobStates: SideJob[] = currentState.sides.map((side) => ({
      // If there isn't an encoder selected, we don't process either
      processorState: side.latestSettings.encoderState
        ? side.latestSettings.processorState
        : defaultProcessorState,
      encoderState: side.latestSettings.encoderState,
    }));

    // Figure out what needs doing:
    const needsDecoding = latestMainJobState.file != mainJobState.file;
    const needsPreprocessing =
      needsDecoding ||
      latestMainJobState.preprocessorState !== mainJobState.preprocessorState;
    const sideWorksNeeded = latestSideJobStates.map((latestSideJob, i) => {
      const needsProcessing =
        needsPreprocessing ||
        !latestSideJob.processorState ||
        // If we're going to or from 'original image' we should reprocess
        !!latestSideJob.encoderState !== !!sideJobStates[i].encoderState ||
        !processorStateEquivalent(
          latestSideJob.processorState,
          sideJobStates[i].processorState,
        );

      return {
        processing: needsProcessing,
        encoding:
          needsProcessing ||
          latestSideJob.encoderState !== sideJobStates[i].encoderState,
      };
    });

    let jobNeeded = false;

    // Abort running tasks & cycle the controllers
    if (needsDecoding || needsPreprocessing) {
      this.mainAbortController.abort();
      this.mainAbortController = new AbortController();
      jobNeeded = true;
      this.activeMainJob = mainJobState;
    }
    for (const [i, sideWorkNeeded] of sideWorksNeeded.entries()) {
      if (sideWorkNeeded.processing || sideWorkNeeded.encoding) {
        this.sideAbortControllers[i].abort();
        this.sideAbortControllers[i] = new AbortController();
        jobNeeded = true;
        this.activeSideJobs[i] = sideJobStates[i];
      }
    }

    if (!jobNeeded) return;

    const mainSignal = this.mainAbortController.signal;
    const sideSignals = this.sideAbortControllers.map((ac) => ac.signal);

    let decoded: ImageData;
    let vectorImage: HTMLImageElement | undefined;

    // Handle decoding
    if (needsDecoding) {
      try {
        assertSignal(mainSignal);
        this.setState({
          source: undefined,
          loading: true,
        });

        // Special-case SVG. We need to avoid createImageBitmap because of
        // https://bugs.chromium.org/p/chromium/issues/detail?id=606319.
        // Also, we cache the HTMLImageElement so we can perform vector resizing later.
        if (mainJobState.file.type.startsWith('image/svg+xml')) {
          vectorImage = await processSvg(mainSignal, mainJobState.file);
          decoded = drawableToImageData(vectorImage);
        } else {
          decoded = await decodeImage(
            mainSignal,
            mainJobState.file,
            // Either worker is good enough here.
            this.workerBridges[0],
          );
        }

        // Set default resize values
        this.setState((currentState) => {
          if (mainSignal.aborted) return {};
          const sides = currentState.sides.map((side) => {
            const resizeState: Partial<ProcessorState['resize']> = {
              width: decoded.width,
              height: decoded.height,
              method: vectorImage ? 'vector' : 'lanczos3',
              // Disable resizing, to make it clearer to the user that something changed here
              enabled: false,
            };
            return cleanMerge(
              side,
              'latestSettings.processorState.resize',
              resizeState,
            );
          }) as [Side, Side];
          return { sides };
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        this.props.showSnack(`源图片解码失败：${err}`);
        throw err;
      }
    } else {
      ({ decoded, vectorImage } = currentState.source!);
    }

    let source: SourceImage;

    // Handle preprocessing
    if (needsPreprocessing) {
      try {
        assertSignal(mainSignal);
        this.setState({
          loading: true,
        });

        const preprocessed = await preprocessImage(
          mainSignal,
          decoded,
          mainJobState.preprocessorState,
          // Either worker is good enough here.
          this.workerBridges[0],
        );

        source = {
          decoded,
          vectorImage,
          preprocessed,
          file: mainJobState.file,
        };

        // Update state for process completion, including intermediate render
        this.setState((currentState) => {
          if (mainSignal.aborted) return {};
          let newState: State = {
            ...currentState,
            loading: false,
            source,
            encodedPreprocessorState: mainJobState.preprocessorState,
            sides: currentState.sides.map((side) => {
              if (side.downloadUrl) URL.revokeObjectURL(side.downloadUrl);

              const newSide: Side = {
                ...side,
                // Intermediate render
                data: preprocessed,
                processed: undefined,
                encodedSettings: undefined,
              };
              return newSide;
            }) as [Side, Side],
          };
          newState = stateForNewSourceData(newState);
          return newState;
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        this.setState({ loading: false });
        this.props.showSnack(`预处理失败：${err}`);
        throw err;
      }
    } else {
      source = currentState.source!;
    }

    // That's the main part of the job done.
    this.activeMainJob = undefined;

    // Allow side jobs to happen in parallel
    sideWorksNeeded.forEach(async (sideWorkNeeded, sideIndex) => {
      try {
        // If processing is true, encoding is always true.
        if (!sideWorkNeeded.encoding) return;

        const signal = sideSignals[sideIndex];
        const jobState = sideJobStates[sideIndex];
        const workerBridge = this.workerBridges[sideIndex];
        let file: File;
        let data: ImageData;
        let processed: ImageData | undefined = undefined;

        // If there's no encoder state, this is "original image", which also
        // doesn't allow processing.
        if (!jobState.encoderState) {
          file = source.file;
          data = source.preprocessed;
        } else {
          const cacheResult = this.encodeCache.match(
            source.preprocessed,
            jobState.processorState,
            jobState.encoderState,
          );

          if (cacheResult) {
            ({ file, processed, data } = cacheResult);
          } else {
            // Set loading state for this side
            this.setState((currentState) => {
              if (signal.aborted) return {};
              const sides = cleanMerge(currentState.sides, sideIndex, {
                loading: true,
              });
              return { sides };
            });

            if (sideWorkNeeded.processing) {
              processed = await processImage(
                signal,
                source,
                jobState.processorState,
                workerBridge,
              );

              // Update state for process completion, including intermediate render
              this.setState((currentState) => {
                if (signal.aborted) return {};
                const currentSide = currentState.sides[sideIndex];
                const side: Side = {
                  ...currentSide,
                  processed,
                  // Intermediate render
                  data: processed,
                  encodedSettings: {
                    ...currentSide.encodedSettings,
                    processorState: jobState.processorState,
                  },
                };
                const sides = cleanSet(currentState.sides, sideIndex, side);
                return { sides };
              });
            } else {
              processed = currentState.sides[sideIndex].processed!;
            }

            file = await compressImage(
              signal,
              processed,
              jobState.encoderState,
              source.file.name,
              workerBridge,
            );
            data = await decodeImage(signal, file, workerBridge);

            this.encodeCache.add({
              data,
              processed,
              file,
              preprocessed: source.preprocessed,
              encoderState: jobState.encoderState,
              processorState: jobState.processorState,
            });
          }
        }

        this.setState((currentState) => {
          if (signal.aborted) return {};
          const currentSide = currentState.sides[sideIndex];

          if (currentSide.downloadUrl) {
            URL.revokeObjectURL(currentSide.downloadUrl);
          }

          const side: Side = {
            ...currentSide,
            data,
            file,
            downloadUrl: URL.createObjectURL(file),
            loading: false,
            processed,
            encodedSettings: {
              processorState: jobState.processorState,
              encoderState: jobState.encoderState,
            },
          };
          const sides = cleanSet(currentState.sides, sideIndex, side);
          return { sides };
        });

        this.activeSideJobs[sideIndex] = undefined;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        this.setState((currentState) => {
          const sides = cleanMerge(currentState.sides, sideIndex, {
            loading: false,
          });
          return { sides };
        });
        this.props.showSnack(`处理失败：${err}`);
        throw err;
      }
    });
  }

  render(
    { files, selectedFileIndex, onBack, onSelectFile }: Props,
    {
      loading,
      sides,
      source,
      mobileView,
      preprocessorState,
      selectedFileIndexes,
      expandedTreePaths,
      batchProcessing,
      batchProgress,
    }: State,
  ) {
    const [leftSide, rightSide] = sides;
    const [leftImageData, rightImageData] = sides.map((i) => i.data);

    const rightOptions = (
      <Options
        index={1}
        source={source}
        mobileView={mobileView}
        processorState={rightSide.latestSettings.processorState}
        encoderState={rightSide.latestSettings.encoderState}
        onEncoderTypeChange={this.onEncoderTypeChange}
        onEncoderOptionsChange={this.onEncoderOptionsChange}
        onProcessorOptionsChange={this.onProcessorOptionsChange}
      />
    );

    const rightResults = (
      <Results
        downloadUrl={rightSide.downloadUrl}
        imageFile={rightSide.file}
        source={source}
        loading={loading || rightSide.loading}
        flipSide={mobileView}
        typeLabel={
          rightSide.latestSettings.encoderState
            ? encoderMap[rightSide.latestSettings.encoderState.type].meta.label
            : `${rightSide.file ? `${rightSide.file.name}` : '原图'}`
        }
      />
    );

    // For rendering, we ideally want the settings that were used to create the
    // data, not the latest settings.
    const leftDisplaySettings =
      leftSide.encodedSettings || leftSide.latestSettings;
    const rightDisplaySettings =
      rightSide.encodedSettings || rightSide.latestSettings;
    const leftImgContain =
      leftDisplaySettings.processorState.resize.enabled &&
      leftDisplaySettings.processorState.resize.fitMethod === 'contain';
    const rightImgContain =
      rightDisplaySettings.processorState.resize.enabled &&
      rightDisplaySettings.processorState.resize.fitMethod === 'contain';
    const treeRows = buildTreeRows(files);
    const visibleRows = visibleTreeRows(treeRows, expandedTreePaths);
    const allSelected = selectedFileIndexes.length === files.length;
    const batchSettings = this.getBatchSettings();
    const batchEncoderLabel = batchSettings.encoderState
      ? encoderMap[batchSettings.encoderState.type].meta.label
      : '未选择';

    return (
      <div class={style.compress}>
        <div class={style.batchPanel}>
          <input
            class={style.hiddenInput}
            ref={linkRef(this, 'addFilesInput')}
            type="file"
            accept="image/*"
            multiple
            onChange={this.onAddFilesInputChange}
          />
          <input
            class={style.hiddenInput}
            ref={linkRef(this, 'addDirectoryInput')}
            type="file"
            accept="image/*"
            multiple
            {...({ webkitdirectory: '' } as any)}
            onChange={this.onAddFilesInputChange}
          />
          <div class={style.batchPanelHeader}>
            <div>
              <strong>图片目录</strong>
              <span class={style.batchCount}>
                {selectedFileIndexes.length}/{files.length}
              </span>
            </div>
            <button
              class={style.batchDownload}
              onClick={this.onBatchDownload}
              disabled={batchProcessing || selectedFileIndexes.length === 0}
            >
              {batchProcessing ? '处理中' : '批量下载 ZIP'}
            </button>
          </div>
          <div class={style.batchUploadActions}>
            <button
              class={style.batchSecondaryButton}
              onClick={this.onOpenAddFilesClick}
            >
              上传图片
            </button>
            <button
              class={style.batchSecondaryButton}
              onClick={this.onOpenAddDirectoryClick}
            >
              上传目录
            </button>
          </div>
          <div class={style.batchSettings}>使用右侧：{batchEncoderLabel}</div>
          <label class={style.batchSelectAll}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={this.onToggleAllFiles}
            />
            全选
          </label>
          {batchProgress && (
            <div class={style.batchProgress}>{batchProgress}</div>
          )}
          <div class={style.batchTree}>
            {visibleRows.map((row) => {
              const expanded = expandedTreePaths.includes(row.path);
              const fileSize =
                row.fileIndex === undefined
                  ? undefined
                  : prettyBytes(files[row.fileIndex].size);
              return (
                <div
                  class={
                    style.batchTreeRow +
                    ' ' +
                    (row.fileIndex === selectedFileIndex
                      ? style.batchTreeRowActive
                      : '')
                  }
                  style={{ paddingLeft: `${row.depth * 14 + 8}px` }}
                >
                  <input
                    type="checkbox"
                    checked={row.fileIndexes.every((index) =>
                      selectedFileIndexes.includes(index),
                    )}
                    onChange={() => this.onToggleTreeRow(row)}
                  />
                  {row.type === 'file' ? (
                    <span class={style.batchTreeToggle} />
                  ) : (
                    <button
                      class={style.batchTreeToggle}
                      onClick={() => this.onToggleTreeDirectory(row.path)}
                      title={expanded ? '收起目录' : '展开目录'}
                    >
                      {expanded ? '▾' : '▸'}
                    </button>
                  )}
                  {row.type === 'file' ? (
                    <button
                      class={style.batchTreeName}
                      onClick={() => onSelectFile(row.fileIndex!)}
                      title={row.path}
                    >
                      {row.label}
                    </button>
                  ) : (
                    <button
                      class={style.batchTreeName}
                      onClick={() => this.onToggleTreeDirectory(row.path)}
                      title={row.path}
                    >
                      {row.label}/
                    </button>
                  )}
                  {fileSize && (
                    <span class={style.batchTreeSize}>
                      {fileSize.value}
                      {fileSize.unit.toLowerCase()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <Output
          source={source}
          mobileView={mobileView}
          leftCompressed={leftImageData}
          rightCompressed={rightImageData}
          leftImgContain={leftImgContain}
          rightImgContain={rightImgContain}
          preprocessorState={preprocessorState}
          onPreprocessorChange={this.onPreprocessorChange}
        />
        <button class={style.back} onClick={onBack}>
          <svg viewBox="0 0 61 53.3">
            <title>返回</title>
            <path
              class={style.backBlob}
              d="M0 25.6c-.5-7.1 4.1-14.5 10-19.1S23.4.1 32.2 0c8.8 0 19 1.6 24.4 8s5.6 17.8 1.7 27a29.7 29.7 0 01-20.5 18c-8.4 1.5-17.3-2.6-24.5-8S.5 32.6.1 25.6z"
            />
            <path
              class={style.backX}
              d="M41.6 17.1l-2-2.1-8.3 8.2-8.2-8.2-2 2 8.2 8.3-8.3 8.2 2.1 2 8.2-8.1 8.3 8.2 2-2-8.2-8.3z"
            />
          </svg>
        </button>
        {mobileView ? (
          <div class={style.options}>
            <multi-panel class={style.multiPanel} open-one-only>
              <div class={style.options2Theme}>{rightResults}</div>
              <div class={style.options2Theme}>{rightOptions}</div>
            </multi-panel>
          </div>
        ) : (
          <div class={style.options2}>
            {rightOptions}
            {rightResults}
          </div>
        )}
      </div>
    );
  }
}
