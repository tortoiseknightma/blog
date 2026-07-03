#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28'
const DATABASE_ID =
  process.env.NOTION_PAGE_ID || '0c30a55a6fed4e2c937cffe179ae0810'
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.NEXT_PUBLIC_LINK ||
  'https://tortoiseknightma.github.io/blog'
const OUTPUT_DIR = path.join(
  process.cwd(),
  'public',
  'images',
  'notion-migrated'
)
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')

const args = new Set(process.argv.slice(2))
const shouldApply = args.has('--apply')
const shouldDownload = shouldApply || args.has('--download')
const verbose = args.has('--verbose')

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage:
  NOTION_TOKEN=... node scripts/migrate-notion-images.js
  NOTION_TOKEN=... node scripts/migrate-notion-images.js --download
  NOTION_TOKEN=... node scripts/migrate-notion-images.js --apply

Options:
  --download  Download Notion-hosted images and write a manifest, without editing Notion.
  --apply     Download missing images and update Notion media references to GitHub Pages URLs.
  --verbose   Print source URLs while scanning or downloading.

Environment:
  NOTION_TOKEN      Required. Internal integration token with content read/update access.
  NOTION_PAGE_ID    Optional. Database ID. Defaults to the current blog database.
  PUBLIC_BASE_URL   Optional. Defaults to https://tortoiseknightma.github.io/blog.

If your network requires a proxy, set NODE_USE_ENV_PROXY=1 before running this
script with Node 24+.
`)
  process.exit(0)
}

if (!process.env.NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN environment variable.')
  process.exit(1)
}

const notionHeaders = {
  Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json'
}

const counters = {
  pages: 0,
  blocks: 0,
  candidates: 0,
  downloaded: 0,
  reused: 0,
  updated: 0,
  skipped: 0,
  failed: 0
}

const failures = []

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry(url, options = {}, attempts = 4, timeoutMs = 120000) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (error) {
      lastError = error
      if (attempt === attempts) {
        break
      }
      await sleep(750 * 2 ** (attempt - 1))
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError
}

function normalizeId(id) {
  const compact = id.replaceAll('-', '')
  return compact.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    '$1-$2-$3-$4-$5'
  )
}

function stableHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function stableAssetSource(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

function isLikelyNotionAsset(url) {
  try {
    const parsed = new URL(url)
    return (
      parsed.hostname.endsWith('notion.so') ||
      parsed.hostname.endsWith('notion.site') ||
      parsed.hostname.includes('notion-static.com') ||
      parsed.hostname.includes('prod-files-secure') ||
      parsed.pathname.includes('prod-files-secure') ||
      parsed.pathname.includes('secure.notion-static.com')
    )
  } catch {
    return false
  }
}

function getMediaUrl(media) {
  if (!media) {
    return null
  }
  if (media.type === 'file') {
    return media.file && media.file.url
  }
  if (media.type === 'external') {
    return media.external && media.external.url
  }
  return null
}

function shouldMigrateMedia(media) {
  const url = getMediaUrl(media)
  if (!url) {
    return false
  }
  return media.type === 'file' || isLikelyNotionAsset(url)
}

function extensionFromContentType(contentType) {
  if (!contentType) {
    return null
  }
  const clean = contentType.split(';')[0].trim().toLowerCase()
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/x-icon': '.ico'
  }
  return map[clean] || null
}

function extensionFromUrl(url) {
  try {
    const parsed = new URL(url)
    const ext = path.extname(decodeURIComponent(parsed.pathname)).toLowerCase()
    if (/^\.(jpg|jpeg|png|gif|webp|svg|avif|bmp|ico)$/.test(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext
    }
  } catch {
    return null
  }
  return null
}

function urlForLocalPath(localPath) {
  const relative = path.relative(path.join(process.cwd(), 'public'), localPath)
  return `${PUBLIC_BASE_URL.replace(/\/$/, '')}/${relative
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/')}`
}

function urlForPublicPath(publicPath) {
  return `${PUBLIC_BASE_URL.replace(/\/$/, '')}/${publicPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { version: 1, generatedAt: null, items: {} }
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

function writeManifest(manifest) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  manifest.generatedAt = new Date().toISOString()
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function notionRequest(method, endpoint, body) {
  const response = await fetchWithRetry(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: notionHeaders,
    body: body ? JSON.stringify(body) : undefined
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${method} ${endpoint} failed: ${response.status} ${text}`)
  }
  return response.json()
}

async function queryAllPages(databaseId) {
  const pages = []
  let startCursor
  do {
    const body = { page_size: 100 }
    if (startCursor) {
      body.start_cursor = startCursor
    }
    const data = await notionRequest(
      'POST',
      `/databases/${normalizeId(databaseId)}/query`,
      body
    )
    pages.push(...data.results)
    startCursor = data.has_more ? data.next_cursor : null
  } while (startCursor)
  return pages
}

async function getBlockChildren(blockId) {
  const blocks = []
  let startCursor
  do {
    const query = new URLSearchParams({ page_size: '100' })
    if (startCursor) {
      query.set('start_cursor', startCursor)
    }
    const data = await notionRequest(
      'GET',
      `/blocks/${normalizeId(blockId)}/children?${query.toString()}`
    )
    blocks.push(...data.results)
    startCursor = data.has_more ? data.next_cursor : null
  } while (startCursor)
  return blocks
}

async function walkBlocks(rootId, visitor) {
  const children = await getBlockChildren(rootId)
  for (const block of children) {
    counters.blocks += 1
    await visitor(block)
    if (block.has_children) {
      await walkBlocks(block.id, visitor)
    }
  }
}

function buildFileBase(candidate) {
  const pagePart = normalizeId(candidate.pageId).slice(0, 8)
  const ownerPart = normalizeId(candidate.ownerId).slice(0, 8)
  const hashPart = stableHash(candidate.stableSource)
  return path.join(OUTPUT_DIR, pagePart, `${candidate.kind}-${ownerPart}-${hashPart}`)
}

function findExistingDownload(candidate) {
  const fileBase = buildFileBase(candidate)
  const dir = path.dirname(fileBase)
  const stem = path.basename(fileBase)
  if (!fs.existsSync(dir)) {
    return null
  }
  const match = fs
    .readdirSync(dir)
    .find(fileName => fileName.startsWith(`${stem}.`))
  return match ? path.join(dir, match) : null
}

async function downloadCandidate(candidate) {
  const manifest = candidate.manifest
  const key = candidate.key
  const existing = manifest.items[key]
  if (existing && fs.existsSync(path.join(process.cwd(), 'public', existing.publicPath))) {
    const publicUrl = urlForPublicPath(existing.publicPath)
    if (existing.publicUrl !== publicUrl) {
      existing.publicUrl = publicUrl
      writeManifest(manifest)
    }
    counters.reused += 1
    return publicUrl
  }

  const existingFile = findExistingDownload(candidate)
  if (existingFile) {
    const stats = fs.statSync(existingFile)
    const publicPath = path.relative(path.join(process.cwd(), 'public'), existingFile)
    const publicUrl = urlForLocalPath(existingFile)
    manifest.items[key] = {
      kind: candidate.kind,
      ownerId: candidate.ownerId,
      pageId: candidate.pageId,
      originalUrl: candidate.originalUrl,
      stableSource: candidate.stableSource,
      publicPath: publicPath.split(path.sep).join('/'),
      publicUrl,
      contentType: null,
      bytes: stats.size,
      downloadedAt: null,
      reusedFromDiskAt: new Date().toISOString()
    }
    writeManifest(manifest)
    counters.reused += 1
    return publicUrl
  }

  const response = await fetchWithRetry(
    candidate.originalUrl,
    {
      headers: { 'User-Agent': 'NotionNext image migration' }
    },
    5,
    180000
  )
  if (!response.ok) {
    throw new Error(`download failed ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type')
  const ext =
    extensionFromContentType(contentType) ||
    extensionFromUrl(candidate.originalUrl) ||
    '.bin'
  const localPath = `${buildFileBase(candidate)}${ext}`
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  fs.writeFileSync(localPath, buffer)

  const publicPath = path.relative(path.join(process.cwd(), 'public'), localPath)
  const publicUrl = urlForLocalPath(localPath)
  manifest.items[key] = {
    kind: candidate.kind,
    ownerId: candidate.ownerId,
    pageId: candidate.pageId,
    originalUrl: candidate.originalUrl,
    stableSource: candidate.stableSource,
    publicPath: publicPath.split(path.sep).join('/'),
    publicUrl,
    contentType,
    bytes: buffer.length,
    downloadedAt: new Date().toISOString()
  }
  writeManifest(manifest)
  counters.downloaded += 1
  return publicUrl
}

async function migrateCandidate(candidate) {
  counters.candidates += 1
  const location = `${candidate.kind}:${candidate.ownerId}`
  if (!shouldDownload) {
    console.log(`SCAN ${location}${verbose ? ` ${candidate.originalUrl}` : ''}`)
    return
  }

  try {
    const publicUrl = await downloadCandidate(candidate)
    console.log(
      `${shouldApply ? 'READY' : 'DOWNLOADED'} ${location} -> ${publicUrl}`
    )

    if (!shouldApply) {
      return
    }

    if (candidate.kind === 'block-image') {
      await notionRequest('PATCH', `/blocks/${normalizeId(candidate.ownerId)}`, {
        image: {
          type: 'external',
          external: { url: publicUrl },
          caption: candidate.caption || []
        }
      })
    } else if (candidate.kind === 'page-cover') {
      await notionRequest('PATCH', `/pages/${normalizeId(candidate.ownerId)}`, {
        cover: { type: 'external', external: { url: publicUrl } }
      })
    } else if (candidate.kind === 'page-icon') {
      await notionRequest('PATCH', `/pages/${normalizeId(candidate.ownerId)}`, {
        icon: { type: 'external', external: { url: publicUrl } }
      })
    }
    counters.updated += 1
  } catch (error) {
    counters.failed += 1
    failures.push(`${location}: ${error.message}`)
    console.error(`FAILED ${location}: ${error.message}`)
  }
}

async function main() {
  const manifest = readManifest()
  const pages = await queryAllPages(DATABASE_ID)
  counters.pages = pages.length

  for (const page of pages) {
    if (page.cover && shouldMigrateMedia(page.cover)) {
      const originalUrl = getMediaUrl(page.cover)
      await migrateCandidate({
        kind: 'page-cover',
        ownerId: page.id,
        pageId: page.id,
        originalUrl,
        stableSource: stableAssetSource(originalUrl),
        key: `page-cover:${page.id}:${stableHash(stableAssetSource(originalUrl))}`,
        manifest
      })
    }

    if (page.icon && shouldMigrateMedia(page.icon)) {
      const originalUrl = getMediaUrl(page.icon)
      await migrateCandidate({
        kind: 'page-icon',
        ownerId: page.id,
        pageId: page.id,
        originalUrl,
        stableSource: stableAssetSource(originalUrl),
        key: `page-icon:${page.id}:${stableHash(stableAssetSource(originalUrl))}`,
        manifest
      })
    }

    await walkBlocks(page.id, async block => {
      if (block.type !== 'image') {
        return
      }
      const image = block.image
      if (!shouldMigrateMedia(image)) {
        counters.skipped += 1
        return
      }
      const originalUrl = getMediaUrl(image)
      await migrateCandidate({
        kind: 'block-image',
        ownerId: block.id,
        pageId: page.id,
        originalUrl,
        stableSource: stableAssetSource(originalUrl),
        caption: image.caption || [],
        key: `block-image:${block.id}:${stableHash(stableAssetSource(originalUrl))}`,
        manifest
      })
    })
  }

  if (shouldDownload) {
    writeManifest(manifest)
  }

  console.log('\nSummary')
  console.log(JSON.stringify(counters, null, 2))
  if (failures.length > 0) {
    console.log('\nFailures')
    for (const failure of failures) {
      console.log(`- ${failure}`)
    }
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error.message)
  process.exit(1)
})
