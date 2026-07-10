const fs = require('fs')
const path = require('path')

describe('GitHub Pages branding', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'pages.yml'),
    'utf8'
  )

  it('uses the requested site description and two-line sidebar signature', () => {
    expect(workflow).toContain(
      'NEXT_PUBLIC_DESCRIPTION: 多元技术爱好者/人生体验派，在AI时代，用写作夺回人思考的权利'
    )
    expect(workflow).toContain(
      "NEXT_PUBLIC_THEME_SIMPLE_LOGO_DESCRIPTION: '<div>多元技术爱好者/人生体验派<br/>在AI时代，用写作夺回人思考的权利</div>'"
    )
  })
})
