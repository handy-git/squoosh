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
  encoderMap,
} from '../../feature-meta';
import Expander from './Expander';
import Toggle from './Toggle';
import Select from './Select';
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
  [P in keyof typeof encoderMap]: { feature: string; suitableFor: string };
} = {
  avif: {
    feature: '压缩率极高，体积最小，画质优秀，支持透明/HDR',
    suitableFor: '网站、移动端、现代 Web',
  },
  browserJPEG: {
    feature: '浏览器兼容优化版 JPEG',
    suitableFor: '普通照片',
  },
  browserGIF: {
    feature: '浏览器兼容导出 GIF，可能只保留静态帧',
    suitableFor: '简单 GIF、兼容兜底',
  },
  browserPNG: {
    feature: '浏览器兼容优化版 PNG',
    suitableFor: 'UI、Logo、透明图',
  },
  jxl: {
    feature: '新一代 JPEG，画质和压缩都强，但兼容性差',
    suitableFor: '未来格式、实验',
  },
  mozJPEG: {
    feature: 'JPEG 的高压缩优化版，体积更小',
    suitableFor: '网站照片',
  },
  oxiPNG: {
    feature: 'PNG 无损极限压缩',
    suitableFor: '图标、透明素材',
  },
  qoi: {
    feature: '“Quite OK Image”，超快编码解码，但压缩一般',
    suitableFor: '游戏/实时加载',
  },
  webP: {
    feature: 'Google 推广格式，兼顾体积和兼容',
    suitableFor: '网站通用首选',
  },
  wp2: {
    feature: 'WebP 下一代实验版',
    suitableFor: '不建议生产用',
  },
};

function encoderDescriptionTitle(type: keyof typeof encoderMap): string {
  const description = encoderDescriptions[type];
  return `${encoderMap[type].meta.label}：${description.feature}。适合：${description.suitableFor}`;
}

const supportedEncoderMapP: Promise<PartialButNotUndefined<typeof encoderMap>> =
  (async () => {
    const supportedEncoderMap: PartialButNotUndefined<typeof encoderMap> = {
      ...encoderMap,
    };

    // Filter out entries where the feature test fails
    await Promise.all(
      Object.entries(encoderMap).map(async ([encoderName, details]) => {
        if ('featureTest' in details && !(await details.featureTest())) {
          delete supportedEncoderMap[encoderName as keyof typeof encoderMap];
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

  private onEncoderTypeChange = (event: Event) => {
    const el = event.currentTarget as HTMLSelectElement;

    // The select element only has values matching encoder types,
    // so 'as' is safe here.
    const type = el.value as OutputType;
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
    const encoderInfoTitle = encoderState
      ? encoderDescriptionTitle(encoderState.type)
      : '保留原始文件，不重新编码';

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

        <section class={`${style.encoderSelectRow} ${style.optionsSection}`}>
          {supportedEncoderMap ? (
            <div class={style.encoderSelectControl}>
              <Select
                value={encoderState ? encoderState.type : 'identity'}
                onChange={this.onEncoderTypeChange}
                large
              >
                <option value="identity" title={encoderInfoTitle}>{`原图 ${
                  this.props.source ? `(${this.props.source.file.name})` : ''
                }`}</option>
                {Object.entries(supportedEncoderMap).map(([type, encoder]) => (
                  <option
                    value={type}
                    title={encoderDescriptionTitle(
                      type as keyof typeof encoderMap,
                    )}
                  >{`${encoder.meta.label} ⓘ`}</option>
                ))}
              </Select>
              <span
                class={style.encoderInfo}
                title={encoderInfoTitle}
                aria-label={encoderInfoTitle}
                tabIndex={0}
              >
                ⓘ
              </span>
            </div>
          ) : (
            <Select large>
              <option>加载中…</option>
            </Select>
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
