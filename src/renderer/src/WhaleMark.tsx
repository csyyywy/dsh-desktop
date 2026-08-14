import raw from './assets/whale.svg?raw'

/** 鲸鱼标志（黑色为应用图标；深色界面里传白色/品牌色以保证可见） */
export default function WhaleMark({
  fill = '#ffffff',
  className = 'h-8 w-8'
}: {
  fill?: string
  className?: string
}) {
  // 把尺寸类直接注入 SVG（替换掉 SVG 自带的 width=512 height=512），否则会渲染成 512px 撑爆布局
  const svg = raw
    .replace('fill="#000"', `fill="${fill}"`)
    .replace('width="512" height="512"', `class="${className}"`)
  return <span className="inline-flex shrink-0" dangerouslySetInnerHTML={{ __html: svg }} />
}
