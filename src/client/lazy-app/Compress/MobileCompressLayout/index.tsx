import { h, Component, ComponentChildren } from 'preact';

import Output from '../Output';
import prettyBytes from '../Results/pretty-bytes';
import type { PreprocessorState } from '../../feature-meta';
import type { SourceImage } from '..';
import * as style from './style.css';
import 'add-css:./style.css';

interface Props {
  source?: SourceImage;
  preprocessorState: PreprocessorState;
  leftCompressed?: ImageData;
  rightCompressed?: ImageData;
  leftImgContain: boolean;
  rightImgContain: boolean;
  rightOptions: ComponentChildren;
  downloadUrl?: string;
  imageFile?: File;
  loading: boolean;
  onBack: () => void;
  onPreprocessorChange: (newState: PreprocessorState) => void;
}

interface State {
  editorOpen: boolean;
}

export default class MobileCompressLayout extends Component<Props, State> {
  state: State = {
    editorOpen: false,
  };

  private toggleEditor = () => {
    this.setState((state) => ({ editorOpen: !state.editorOpen }));
  };

  private closeEditor = () => {
    this.setState({ editorOpen: false });
  };

  render(
    {
      source,
      preprocessorState,
      leftCompressed,
      rightCompressed,
      leftImgContain,
      rightImgContain,
      rightOptions,
      downloadUrl,
      imageFile,
      loading,
      onBack,
      onPreprocessorChange,
    }: Props,
    { editorOpen }: State,
  ) {
    const downloadDisabled = loading || !downloadUrl || !imageFile;
    const prettySize = imageFile && prettyBytes(imageFile.size);
    const percent =
      source && imageFile
        ? Math.round(
            imageFile.size > source.file.size
              ? (imageFile.size / source.file.size) * 100 - 100
              : 100 - (imageFile.size / source.file.size) * 100,
          )
        : undefined;
    const direction =
      source && imageFile && imageFile.size > source.file.size ? '↑' : '↓';

    return (
      <div class={style.mobileCompress}>
        <div class={style.preview}>
          <Output
            source={source}
            mobileView
            leftCompressed={leftCompressed}
            rightCompressed={rightCompressed}
            leftImgContain={leftImgContain}
            rightImgContain={rightImgContain}
            preprocessorState={preprocessorState}
            onPreprocessorChange={onPreprocessorChange}
          />
        </div>
        <button class={style.backButton} onClick={onBack}>
          返回
        </button>
        {editorOpen && (
          <button
            class={style.scrim}
            onClick={this.closeEditor}
            aria-label="收起编辑"
          />
        )}
        <div class={style.bottomBar}>
          <button class={style.editButton} onClick={this.toggleEditor}>
            {editorOpen ? '收起编辑' : '编辑'}
          </button>
          <a
            class={
              downloadDisabled
                ? `${style.downloadButton} ${style.downloadButtonDisabled}`
                : style.downloadButton
            }
            href={downloadUrl}
            download={imageFile ? imageFile.name : ''}
            aria-disabled={downloadDisabled}
          >
            <span>{loading ? '处理中' : '下载'}</span>
            <span class={style.downloadMeta}>
              {prettySize
                ? `${prettySize.value} ${prettySize.unit} · ${direction}${percent}%`
                : '等待处理'}
            </span>
          </a>
        </div>
        <div
          class={
            editorOpen
              ? `${style.editorSheet} ${style.editorSheetOpen}`
              : style.editorSheet
          }
        >
          <div class={style.sheetHeader}>
            <button class={style.sheetHandle} onClick={this.toggleEditor}>
              编辑
            </button>
          </div>
          <div class={style.editorContent}>{rightOptions}</div>
        </div>
      </div>
    );
  }
}
