import Image from 'next/image'

/** The supplied brand artwork is preserved; the small mark is a CSS viewport. */
export function AidenMark({ size = 32 }: { size?: number }) {
  return <span className="aiden-brand-mark" style={{ width: size, height: size }} aria-hidden="true">
    <Image src="/brand/aiden-logo.png" alt="" width={1484} height={1060} unoptimized />
  </span>
}
