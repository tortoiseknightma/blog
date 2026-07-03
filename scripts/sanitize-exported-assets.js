const fs = require('fs')
const path = require('path')

const outDir = path.join(process.cwd(), 'out')
const homeBanner = process.env.NEXT_PUBLIC_HOME_BANNER_IMAGE
const avatar = process.env.NEXT_PUBLIC_AVATAR
const githubProfile = process.env.NEXT_PUBLIC_CONTACT_GITHUB

if (!homeBanner) {
  console.log('[sanitize-exported-assets] NEXT_PUBLIC_HOME_BANNER_IMAGE is empty; skipped')
  process.exit(0)
}

const fileExtensions = new Set(['.html', '.js', '.json', '.xml', '.txt'])
const exactReplacements = [
  [
    /https:\/\/prod-files-secure\.s3\.us-west-2\.amazonaws\.com\/2867c018-b433-489c-b6e5-aa79032c777c\/d32081a8-123b-4141-9979-a46413c93e0a\/Majin\.Archer\.webp/g,
    avatar || homeBanner
  ],
  [
    /https:\/\/prod-files-secure\.s3\.us-west-2\.amazonaws\.com\/2867c018-b433-489c-b6e5-aa79032c777c\/4857dbe2-ce75-4e54-a1ed-3d20c6cd50ee\/befb1c82323c0ba6a83df6d91b8e48e4af3ac0da9af908de1ad15bb8aa353fe8\.webp/g,
    homeBanner
  ],
  [
    /https:\/\/prod-files-secure\.s3\.us-west-2\.amazonaws\.com\/2867c018-b433-489c-b6e5-aa79032c777c\/77fbe2ad-ace0-498f-af3a-cdf137ddacd8\/SocialMediaPreviewImage\.png/g,
    homeBanner
  ]
]

const fallbackReplacements = [
  /https:\/\/prod-files-secure\.s3\.[^"'<>\\\s)]+/g,
  /https:\/\/secure\.notion-static\.com\/[^"'<>\\\s)]+/g,
  /https:\/\/www\.notion\.so\/image\/[^"'<>\\\s)]+/g
]

const githubReplacements = githubProfile
  ? [[/https:\/\/github\.com\/Tortoise0Knight(?:\/NotionNext)?/g, githubProfile]]
  : []

let scanned = 0
let changed = 0
let replacements = 0

function sanitizeContent(content) {
  let next = content

  for (const [pattern, replacement] of exactReplacements) {
    next = next.replace(pattern, () => {
      replacements += 1
      return replacement
    })
  }

  for (const pattern of fallbackReplacements) {
    next = next.replace(pattern, () => {
      replacements += 1
      return homeBanner
    })
  }

  for (const [pattern, replacement] of githubReplacements) {
    next = next.replace(pattern, () => {
      replacements += 1
      return replacement
    })
  }

  return next
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(filePath)
      continue
    }
    if (!fileExtensions.has(path.extname(entry.name))) continue

    scanned += 1
    const content = fs.readFileSync(filePath, 'utf8')
    const sanitized = sanitizeContent(content)
    if (sanitized !== content) {
      fs.writeFileSync(filePath, sanitized)
      changed += 1
    }
  }
}

if (!fs.existsSync(outDir)) {
  throw new Error(`Export directory does not exist: ${outDir}`)
}

walk(outDir)
console.log(
  `[sanitize-exported-assets] scanned=${scanned} changed=${changed} replacements=${replacements}`
)
