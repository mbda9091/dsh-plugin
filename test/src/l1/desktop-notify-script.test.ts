import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULTS, buildScript, escapeXml, literal } from '@local/desktop-notify'
import type { Options } from '@local/desktop-notify'
import { clip } from '@local/notify-core'

const OPTIONS: Options = {
  ...DEFAULTS,
  appId: 'com.test.dsh',
  soundFile: 'C:\\Windows\\Media\\test.wav',
  sound: true,
}

function xmlOf(script: string): string {
  const match = /^\$xml = '([\s\S]*?)'$/m.exec(script)
  assert.ok(match !== null, 'the generated script must contain the toast XML literal')
  return (match[1] ?? '').replace(/''/g, "'")
}

describe('L1 desktop-notify: escaping', () => {
  it('escapes XML entities exactly once, ampersand first', () => {
    assert.equal(escapeXml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;')
    assert.equal(escapeXml('a & b'), 'a &amp; b')
    assert.equal(escapeXml('&amp;'), '&amp;amp;')
  })

  it('doubles single quotes in PowerShell literals', () => {
    assert.equal(literal("it's"), "'it''s'")
    assert.equal(literal('C:\\a\\b.wav'), "'C:\\a\\b.wav'")
    assert.equal(literal('a\nb'), "'a\nb'")
  })

  it('collapses whitespace and bounds the text', () => {
    assert.equal(clip('  a \n b  ', 100), 'a b')
    assert.equal(clip('abcdef', 4), 'abc…')
    assert.equal(clip('abcd', 4), 'abcd')
    assert.equal(clip('abcde', 4).length, 4)
    assert.equal(clip('', 5), '')
  })
})

describe('L1 desktop-notify: PowerShell script', () => {
  it('embeds escaped title and body', () => {
    const script = buildScript("a'b & <c>", 'line1\nline2', OPTIONS)
    assert.ok(script.includes("$title = 'a''b & <c>'"))
    assert.ok(script.includes("$body = 'line1\nline2'"))
    const xml = xmlOf(script)
    assert.ok(xml.includes('<text>a&apos;b &amp; &lt;c&gt;</text>'))
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'the toast XML must not contain a bare ampersand')
  })

  it('keeps the toast XML well-formed enough to load', () => {
    const xml = xmlOf(buildScript('title', 'body', OPTIONS))
    assert.ok(xml.startsWith('<toast activationType="protocol" launch="dsh-notify:focus">'))
    assert.ok(xml.includes('<binding template="ToastGeneric">'))
    assert.ok(xml.endsWith('</toast>'))
    assert.equal((xml.match(/<text>/g) ?? []).length, 2)
  })

  it('passes the configured app id and sound file as literals', () => {
    const script = buildScript('t', 'b', OPTIONS)
    assert.ok(script.includes("$appId = 'com.test.dsh'"))
    assert.ok(script.includes("$soundFile = 'C:\\Windows\\Media\\test.wav'"))
    assert.ok(script.includes('$playSound = $true'))
  })

  it('can disable the sound', () => {
    const script = buildScript('t', 'b', { ...OPTIONS, sound: false })
    assert.ok(script.includes('$playSound = $false'))
  })

  it('falls back from toast to balloon and never uses the EncodedCommand pipe', () => {
    const script = buildScript('t', 'b', OPTIONS)
    assert.ok(script.includes('ToastNotificationManager'))
    assert.ok(script.includes('ShowBalloonTip'))
    assert.ok(script.includes('SystemSounds'))
    assert.ok(!script.includes('-EncodedCommand'))
  })
})
