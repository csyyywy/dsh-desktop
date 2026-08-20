import raw from './assets/whale.svg?raw'

/** 鲸鱼标志（黑色为应用图标；深色界面里传白色/品牌色以保证可见）。
 *  1.11 修复：不再对 SVG 源码做脆弱字符串替换（源码一改就静默失效），
 *  改为 CSS 覆盖 presentation attribute——.whale-mark 的 color 决定 currentColor，
 *  尺寸由 wrapper 的 className 控制（svg 100% 撑满）。 */
export default function WhaleMark({
  fill = '#ffffff',
  className = 'h-8 w-8'
}: {
  fill?: string
  className?: string
}) {
  return (
    <span
      className={`whale-mark inline-flex shrink-0 ${className}`}
      style={{ color: fill }}
      dangerouslySetInnerHTML={{ __html: raw }}
    />
  )
}
