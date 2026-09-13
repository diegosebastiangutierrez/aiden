import { ProductIcon } from './ProductIcon'

export function AppBrandIcon({ app, size = 24 }: { app: string; size?: number }) {
  if (app.toLowerCase() === 'github') return <span className="app-brand-mark" aria-hidden="true">
    {/* Native image keeps the supplied brand artwork unchanged and available offline. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/brands/github.svg" width={size} height={size * 96 / 98} alt="" />
  </span>
  return <ProductIcon name={app.toLowerCase() === 'gmail' ? 'mail' : 'apps'} size={size} aria-hidden="true" />
}
