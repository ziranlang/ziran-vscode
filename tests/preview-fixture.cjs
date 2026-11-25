const fs = require('node:fs/promises');
const path = require('node:path');
const { parse, stringify } = require('@iarna/toml');

const source = `App :: #import "kryon/app";
Button :: #import "kryon/button";
Text :: #import "kryon/text";
#import "kryon/geometry"
#import "kryon/session"
#import "std/number_text"

clicks: s32;

Frame :: (frame: App.Frame) {
    session := Session.{.slot = frame.slot, .epoch = frame.epoch}
    viewport := frame.viewport
    if Button.Draw(session, Button.Props.{.bounds = .{viewport.x + 20.0, viewport.y + 72.0, 300.0, 44.0},
        .label = "Continue"}) != 0 { clicks += 1 }
    digits: [24]u8
    Text.Draw(session, Text.Props.{.bounds = .{viewport.x + 20.0, viewport.y + 420.0, 100.0, 36.0},
        .text = FormatInteger(cast(s64)clicks, digits[:])})
}

main :: () -> s32 { return App.Run(App.Window.{.title = "button"}, Frame) }
`;


exports.createFixture = async (runtime, repo) => {
  const project = path.join(runtime, 'button');
  const kryon = process.env.ZIRAN_KRYON_ROOT || path.resolve(repo, '../../kryonlabs/kryon');
  const example = path.join(kryon, 'examples/button');
  const manifest = parse(await fs.readFile(path.join(example, 'ziran.toml'), 'utf8'));
  manifest.package = {name:'button', entry:'button.zi', module_roots:['.'], tool:'kryon'};
  const profile = process.env.ZIRAN_PREVIEW_PROFILE || 'portable_web';
  manifest.tool = {kryon:{default_profile:profile,profiles:{[profile]:profile === 'web' ? {backend:'canvas'} : {backend:'canvas',codegen:'zx'}}}};
  const local = parse(await fs.readFile(path.join(example, 'ziran.local.toml'), 'utf8'));
  for (const [name, location] of Object.entries(local.overrides || {})) {
    if (typeof location !== 'string') throw new Error(`Unexpected override format: ${name}`);
    local.overrides[name] = path.resolve(example, location);
  }
  local.overrides ||= {};
  local.overrides.kryon = kryon;
  local.overrides.ziran = process.env.ZIRAN_COMPILER_ROOT || path.resolve(repo, '../ziran');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'button.zi'), source);
  await fs.writeFile(path.join(project, 'ziran.toml'), stringify(manifest));
  await fs.writeFile(path.join(project, 'ziran.local.toml'), stringify(local));
  const lock = await require('../preview.cjs').runCommand('ziran', ['lock'], project);
  if (lock.code !== 0) throw new Error(`Fixture package lock failed: ${lock.stdout}${lock.stderr}`);
  return {project, source};
};
