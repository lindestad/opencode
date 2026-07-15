import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import path from "node:path"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { tmpdir } from "./fixture/fixture"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("update prompt opens before the session picker", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
    if (url.pathname === "/session")
      return json([
        {
          id: "ses_pick",
          title: "Pick me",
          slug: "ses_pick",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 1 },
        },
      ])
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let finishUpdateCheck!: (updateAvailable: boolean) => void
  const startupUpdateCheck = () =>
    new Promise<boolean>((resolve) => {
      finishUpdateCheck = resolve
    })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { sessionPicker: true, startupUpdateCheck },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(
        Effect.provide(AppNodeBuilder.build(Global.node, [[Global.node, Global.layerWith({ state: tmp.path })]])),
      ),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    expect(api?.route.current.name).toBe("home")
    expect(setup.captureCharFrame()).not.toContain("Sessions")

    events.emit({
      directory: "global",
      payload: {
        id: "evt_update",
        type: "installation.update-available",
        properties: { version: "99.0.0" },
      },
    })
    finishUpdateCheck(true)
    await setup.renderOnce()
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Update Available")

    setup.mockInput.pressArrow("left")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Sessions")
    expect(setup.captureCharFrame()).toContain("Pick me")

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
