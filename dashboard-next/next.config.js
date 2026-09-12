/** @type {import('next').NextConfig} */
const path = require('path')

const nextConfig = {
  // Static export: produces a self-contained `out/` of HTML/JS/CSS that the
  // Aiden workbench bridge serves directly (single origin, alongside /api/*).
  // No Node server for the dashboard — `aiden web` serves the files.
  output: 'export',

  // No image optimization server in a static export.
  images: { unoptimized: true },

  // Share the same project root with the browser-safe workflow compiler.
  outputFileTracingRoot: path.join(__dirname, '..'),
  // The visual compiler is shared with the runtime; its imports are type-only.
  turbopack: { root: path.join(__dirname, '..') },
}

module.exports = nextConfig
