import { h, Component } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import { cleanSet, cleanMerge } from '../../util/clean-modify';

import type { SourceImage, OutputType } from '..';
import {
  EncoderOptions,
  EncoderState,
  ProcessorState,
  ProcessorOptions,
  EncoderType,
  encoderMap,
} from '../../feature-meta';
import Expander from './Expander';
import Toggle from './Toggle';
import { Options as QuantOptionsComponent } from 'features/processors/quantize/client';
import { Options as ResizeOptionsComponent } from 'features/processors/resize/client';

interface Props {
  index: 0 | 1;
  mobileView: boolean;
  source?: SourceImage;
  encoderState?: EncoderState;
  processorState: ProcessorState;
  onEncoderTypeChange(index: 0 | 1, newType: OutputType): void;
  onEncoderOptionsChange(index: 0 | 1, newOptions: EncoderOptions): void;
  onProcessorOptionsChange(index: 0 | 1, newOptions: ProcessorState): void;
}

interface State {
  supportedEncoderMap?: PartialButNotUndefined<typeof encoderMap>;
}

type PartialButNotUndefined<T> = {
  [P in keyof T]: T[P];
};

const encoderDescriptions: {
  [P in keyof typeof encoderMap]: string;
} = {
  avif: '超高压缩 · 移动网页',
  browserJPEG: '标准有损 · 照片分享',
  browserGIF: '动图兼容 · 表情动画',
  browserPNG: '无损透明 · 图标素材',
  jxl: '高压缩 · 实验格式',
  mozJPEG: '极限压缩 · 网页照片',
  oxiPNG: '无损瘦身 · UI透明图',
  qoi: '极速编解 · 游戏缓存',
  webP: '均衡压缩 · 网站通用',
  wp2: '实验新版 · 不建议生产',
};

const hiddenEncoderTypes = new Set<EncoderType>(['jxl', 'wp2']);

function sortedEncoderEntries(
  supportedEncoderMap: PartialButNotUndefined<typeof encoderMap>,
) {
  const entries = Object.entries(supportedEncoderMap);
  const webPIndex = entries.findIndex(([type]) => type === 'webP');
  const avifIndex = entries.findIndex(([type]) => type === 'avif');

  if (webPIndex !== -1 && avifIndex !== -1) {
    const webPEntry = entries[webPIndex];
    entries[webPIndex] = entries[avifIndex];
    entries[avifIndex] = webPEntry;
  }

  return entries;
}

const supportedEncoderMapP: Promise<PartialButNotUndefined<typeof encoderMap>> =
  (async () => {
    const supportedEncoderMap: PartialButNotUndefined<typeof encoderMap> = {
      ...encoderMap,
    };

    // Filter out entries where the feature test fails
    await Promise.all(
      Object.entries(encoderMap).map(async ([encoderName, details]) => {
        const encoderType = encoderName as keyof typeof encoderMap;
        if (
          hiddenEncoderTypes.has(encoderType) ||
          ('featureTest' in details && !(await details.featureTest()))
        ) {
          delete supportedEncoderMap[encoderType];
        }
      }),
    );

    return supportedEncoderMap;
  })();

export default class Options extends Component<Props, State> {
  state: State = {
    supportedEncoderMap: undefined,
  };

  constructor() {
    super();
    supportedEncoderMapP.then((supportedEncoderMap) =>
      this.setState({ supportedEncoderMap }),
    );
  }

  private setEncoderType = (type: OutputType) => {
    this.props.onEncoderTypeChange(this.props.index, type);
  };

  private onProcessorEnabledChange = (event: Event) => {
    const el = event.currentTarget as HTMLInputElement;
    const processor = el.name.split('.')[0] as keyof ProcessorState;

    this.props.onProcessorOptionsChange(
      this.props.index,
      cleanSet(this.props.processorState, `${processor}.enabled`, el.checked),
    );
  };

  private onQuantizerOptionsChange = (opts: ProcessorOptions['quantize']) => {
    this.props.onProcessorOptionsChange(
      this.props.index,
      cleanMerge(this.props.processorState, 'quantize', opts),
    );
  };

  private onResizeOptionsChange = (opts: ProcessorOptions['resize']) => {
    this.props.onProcessorOptionsChange(
      this.props.index,
      cleanMerge(this.props.processorState, 'resize', opts),
    );
  };

  private onEncoderOptionsChange = (newOptions: EncoderOptions) => {
    this.props.onEncoderOptionsChange(this.props.index, newOptions);
  };

  render(
    { source, encoderState, processorState }: Props,
    { supportedEncoderMap }: State,
  ) {
    const encoder = encoderState && encoderMap[encoderState.type];
    const EncoderOptionComponent =
      encoder && 'Options' in encoder ? encoder.Options : undefined;

    return (
      <div
        class={
          style.optionsScroller +
          ' ' +
          (encoderState ? '' : style.originalImage)
        }
      >
        <Expander>
          {!encoderState ? null : (
            <div>
              <h3 class={style.optionsTitle}>编辑</h3>
              <label class={style.sectionEnabler}>
                调整尺寸
                <Toggle
                  name="resize.enable"
                  checked={!!processorState.resize.enabled}
                  onChange={this.onProcessorEnabledChange}
                />
              </label>
              <Expander>
                {processorState.resize.enabled ? (
                  <ResizeOptionsComponent
                    isVector={Boolean(source && source.vectorImage)}
                    inputWidth={source ? source.preprocessed.width : 1}
                    inputHeight={source ? source.preprocessed.height : 1}
                    options={processorState.resize}
                    onChange={this.onResizeOptionsChange}
                  />
                ) : null}
              </Expander>

              <label class={style.sectionEnabler}>
                减少颜色
                <Toggle
                  name="quantize.enable"
                  checked={!!processorState.quantize.enabled}
                  onChange={this.onProcessorEnabledChange}
                />
              </label>
              <Expander>
                {processorState.quantize.enabled ? (
                  <QuantOptionsComponent
                    options={processorState.quantize}
                    onChange={this.onQuantizerOptionsChange}
                  />
                ) : null}
              </Expander>
            </div>
          )}
        </Expander>

        <h3 class={style.optionsTitle}>压缩</h3>

        <section class={`${style.encoderPicker} ${style.optionsSection}`}>
          {supportedEncoderMap ? (
            <div class={style.encoderGrid}>
              <button
                type="button"
                class={`${style.encoderButton} ${
                  encoderState ? '' : style.encoderButtonSelected
                }`}
                onClick={() => this.setEncoderType('identity')}
              >
                <span class={style.encoderName}>原图</span>
                <span class={style.encoderHint}>
                  {this.props.source
                    ? this.props.source.file.name
                    : '不重新编码'}
                </span>
              </button>
              {sortedEncoderEntries(supportedEncoderMap).map(
                ([type, encoder]) => {
                  const encoderType = type as EncoderType;
                  return (
                    <button
                      type="button"
                      class={`${style.encoderButton} ${
                        encoderState && encoderState.type === encoderType
                          ? style.encoderButtonSelected
                          : ''
                      }`}
                      onClick={() => this.setEncoderType(encoderType)}
                    >
                      <span class={style.encoderName}>
                        {encoder.meta.label}
                      </span>
                      <span class={style.encoderHint}>
                        {encoderDescriptions[encoderType]}
                      </span>
                    </button>
                  );
                },
              )}
            </div>
          ) : (
            <div class={style.encoderLoading}>加载中…</div>
          )}
        </section>

        <Expander>
          {EncoderOptionComponent && (
            <EncoderOptionComponent
              options={
                // Casting options, as encoderOptionsComponentMap[encodeData.type] ensures
                // the correct type, but typescript isn't smart enough.
                encoderState!.options as any
              }
              onChange={this.onEncoderOptionsChange}
            />
          )}
        </Expander>
      </div>
    );
  }
}
