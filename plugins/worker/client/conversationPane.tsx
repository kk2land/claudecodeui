import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  WorkerConversationMessage,
  WorkerType,
} from "../shared/contracts.js";
import type { WorkerConversationOutput, WorkerHost } from "./api.js";
import { workerApi } from "./api.js";
import {
  createConversationStream,
  type ConversationStream,
} from "./conversation.js";

/** Distance from the top, in pixels, still counted as reading the loaded window's start. */
const TOP_PROXIMITY_PX = 80;
/** Finger travel at the top of a short panel that counts as asking for older rows. */
const PULL_STEP_PX = 24;
/** Vertical travel before a touch is known to be a vertical drag rather than a sideways one. */
const TOUCH_SLOP_PX = 8;
/**
 * A reader's own backward page. A log page is clamped to 256 KiB on the server, so asking for
 * the full page reads four times as much history per round trip, which cuts the requests and
 * window replays a long log needs on a phone. The opening fill keeps the default 64 KiB page so
 * its budget stays cheap.
 */
const EARLIER_PAGE_BYTES = 256 * 1024;
/** Next poll after new bytes; an empty page keeps the cheaper one-second retry. */
const LIVE_POLL_MS = 250;
const IDLE_POLL_MS = 1000;
/** One message row of either renderer, and the displayed blocks inside it that stay stable. */
const MESSAGE_SELECTOR = ".chat-message, .worker-conv-row";
const ANCHOR_SELECTOR = "p, li, pre, h1, h2, h3, h4";
/**
 * Automatic backward pages read for the opening window. A tail page can land inside one large
 * event (Pi's `agent_end`, a Codex output snapshot) or on a few collapsed tool rows, so the first
 * screen fills backwards until it scrolls. The cap keeps a long log from being read in full.
 */
const PREFILL_PAGES = 4;

/**
 * The parsed conversation of one run plus the byte window it was parsed from. Rows are produced
 * from the run's existing event pages, so switching worker/run must drop the old state instead of
 * showing it under a new header. The first request reads only the end of the log; `before` is the
 * offset where the loaded window starts and is null once the log start is included.
 */
type ConversationState = {
  key: string;
  prompt: string | null;
  messages: WorkerConversationMessage[];
  done: boolean;
  /** The end-of-log page arrived; only then is a prompt known to belong to the tail. */
  started: boolean;
  before: string | null;
  loadingEarlier: boolean;
  error: string;
};

const EMPTY_CONVERSATION: ConversationState = {
  key: "",
  prompt: null,
  messages: [],
  done: false,
  started: false,
  before: null,
  loadingEarlier: false,
  error: "",
};

/**
 * An empty poll page rewrites nothing, so its rows keep their object identity. Comparing the
 * published state against that window keeps an idle run from redrawing the whole host list.
 */
function sameConversation(
  previous: ConversationState,
  next: ConversationState,
): boolean {
  return (
    previous.key === next.key &&
    previous.prompt === next.prompt &&
    previous.done === next.done &&
    previous.started === next.started &&
    previous.before === next.before &&
    previous.loadingEarlier === next.loadingEarlier &&
    previous.error === next.error &&
    previous.messages.length === next.messages.length &&
    next.messages.every((row, index) => row === previous.messages[index])
  );
}

/** Mutable pager state of one run; publishing only replaces the rows on screen. */
type ConversationWindow = {
  raw: string;
  reader: ConversationStream;
  before: string | null;
  after: string | null;
  done: boolean;
  /** The first (tail) page arrived; `/input` alone never publishes a prompt row. */
  started: boolean;
  prompt: string | null;
  loadingEarlier: boolean;
  /** Automatic backward pages the opening window may still read; a reader gesture ends them. */
  prefill: number;
};

/**
 * Host-rendered conversation. The host view owns "follow latest" inside this wrapper, which is the
 * plugin's scroll container for both the host view and the fallback.
 */
function ConversationHostView({
  host,
  provider,
  messages,
  scrollRef,
}: {
  host: WorkerHost;
  provider: string;
  messages: WorkerConversationMessage[];
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const node = useRef<HTMLDivElement | null>(null);
  const view = useRef<WorkerConversationOutput | null>(null);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      node.current = element;
      scrollRef.current = element;
    },
    [scrollRef],
  );
  useEffect(() => {
    const mount = host.mountConversationOutput;
    const element = node.current;
    if (!mount || !element) return;

    const current = mount(element, { provider, messages });
    view.current = current;
    return () => {
      view.current = null;
      current.dispose();
    };
    // Rows flow through `update`; the view itself is only recreated for another provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, provider]);
  useEffect(() => {
    view.current?.update(messages);
  }, [messages]);
  return (
    <div className="worker-conv-host" aria-label="对话内容" ref={attach} />
  );
}

function ConversationRow({ row }: { row: WorkerConversationMessage }) {
  const label =
    row.role === "user"
      ? "用户"
      : row.role === "assistant"
        ? row.thinking
          ? "思考"
          : "助手"
        : row.role === "tool"
          ? "工具"
          : "错误";
  return (
    <li
      className={
        "worker-conv-row worker-conv-" +
        row.role +
        (row.thinking ? " worker-conv-thinking" : "")
      }
    >
      <div className="worker-conv-meta">
        <span>{label}</span>
        {row.role === "tool" && row.toolName ? <code>{row.toolName}</code> : null}
        {row.streaming ? <span className="worker-conv-live">生成中…</span> : null}
      </div>
      {row.text ? <pre>{row.text}</pre> : null}
      {row.toolInput ? <pre>{JSON.stringify(row.toolInput, null, 2)}</pre> : null}
      {row.toolOutput ? (
        <pre className={row.isError ? "worker-conv-error" : undefined}>
          {row.toolOutput}
        </pre>
      ) : null}
    </li>
  );
}

/** Basic readable conversation for a host without the optional conversation view. */
function ConversationFallback({
  messages,
  loading,
  scrollRef,
}: {
  messages: WorkerConversationMessage[];
  loading: boolean;
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
    },
    [scrollRef],
  );
  return (
    <div className="worker-conv-fallback">
      <div className="worker-conv-scroll" aria-label="对话内容" ref={attach}>
        {messages.length ? (
          <ol className="worker-conv-list">
            {messages.map((row) => (
              <ConversationRow key={row.id} row={row} />
            ))}
          </ol>
        ) : (
          <p className="worker-muted">
            {loading ? "正在读取对话…" : "暂无可读对话"}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Keeps the conversation scrolled to the newest row while the reader follows it. Scrolling up
 * pauses following until the reader asks for the latest again, so live output never yanks the
 * position they are reading. Only a change of the rendered rows or an explicit return to latest
 * moves the position: an idle poll and a parent redraw leave it alone.
 */
export function useFollowLatest(
  scroller: React.MutableRefObject<HTMLDivElement | null>,
  rows: WorkerConversationMessage[],
): {
  follow: boolean;
  setFollow(value: boolean): void;
} {
  const [follow, setFollowState] = useState(true);
  const followRef = useRef(true);
  const setFollow = useCallback((value: boolean) => {
    followRef.current = value;
    setFollowState(value);
  }, []);
  // The host view updates its rows in its own child effect, which runs before this parent effect,
  // so the offset is computed from the content that is already on screen.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [follow, rows, scroller]);
  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const near =
      node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    if (near !== followRef.current) setFollow(near);
  }, [scroller, setFollow]);
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, [onScroll, scroller]);
  return { follow, setFollow };
}

/**
 * Reads one run's conversation backwards from the end of its existing `events.log`, using only
 * the page API and the client-side event mapping. Returns the rows to render plus the pager
 * controls shared by the full detail console and the compact overview cards.
 */
export function useRunConversation({
  api,
  workerType,
  workerId,
  runId,
  finalText,
}: {
  api: ReturnType<typeof workerApi>;
  workerType: WorkerType;
  workerId: string;
  runId: string;
  finalText: string | null;
}) {
  const key = workerId + ":" + runId;
  const [conversation, setConversation] =
    useState<ConversationState>(EMPTY_CONVERSATION);
  /** Last state handed to React; an unchanged poll page must not redraw it. */
  const shown = useRef<ConversationState>(EMPTY_CONVERSATION);
  const show = useCallback((next: ConversationState) => {
    if (sameConversation(shown.current, next)) return;
    shown.current = next;
    setConversation(next);
  }, []);
  // The conversation's scroll container is the plugin's wrapper in both render paths.
  const scroller = useRef<HTMLDivElement | null>(null);
  /** Watches the prepended page's layout so the reading position can follow it. */
  const hold = useRef<ResizeObserver | null>(null);
  /** Last scroll offset the conversation listener accounted for, shared with the pager. */
  const previousTop = useRef(0);
  useEffect(() => () => hold.current?.disconnect(), []);
  /**
   * Keeps the message the reader is looking at in place while older rows are inserted above it.
   * Its screen position is recorded before the rows are published and re-applied on every later
   * layout change of the scroller content: the host renders those rows on its own root and a
   * row's real height settles only after the commit, so a height delta alone keeps drifting.
   */
  const holdScroll = useCallback((node: HTMLDivElement | null) => {
    hold.current?.disconnect();
    hold.current = null;
    if (!node) return;
    const content = node.firstElementChild;
    if (!content) return;
    // A tail page that fits the panel has no scroll position to keep. The host still follows the
    // newest row, so the first page with real overflow must open at the earlier rows it loaded.
    if (node.scrollHeight <= node.clientHeight) {
      const observer = new ResizeObserver(() => {
        if (node.scrollHeight <= node.clientHeight) return;
        observer.disconnect();
        if (hold.current === observer) hold.current = null;
        node.scrollTop = 0;
        previousTop.current = node.scrollTop;
      });
      observer.observe(content);
      hold.current = observer;
      return;
    }
    const boxTop = () => node.getBoundingClientRect().top;
    const contentTop = (element: Element) =>
      element.getBoundingClientRect().top - boxTop() + node.scrollTop;
    // The visible message at the top is the one being read; its own displayed block (a paragraph,
    // list item, code block or heading) is stable even when the message as a whole gains a prefix
    // while the window is parsed again.
    const top = boxTop() + 4;
    const messages = [...node.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)];
    const anchor = messages
      .filter((message) => message.textContent?.trim() && message.getBoundingClientRect().bottom > top)
      .flatMap((message) => [
        ...[...message.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)].filter(
          (block) => block.textContent?.trim() && block.getBoundingClientRect().bottom > top,
        ),
        message,
      ])
      .find((block) => block.textContent?.trim());
    if (!anchor) return;
    const anchorText = anchor.textContent!.trim();
    // An identical command or paragraph can occur twice in the window and again in the page
    // inserted above, so the anchor keeps its ordinal among the equal blocks.
    const matches = () =>
      [...node.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR + ", " + ANCHOR_SELECTOR)]
        .filter(
          (block) =>
            block.tagName === anchor.tagName && block.textContent?.trim() === anchorText,
        )
        .reverse();
    const anchorIndex = matches().indexOf(anchor);
    let anchorAt = contentTop(anchor);
    let height = node.scrollHeight;
    const observer = new ResizeObserver(() => {
      const found = matches()[anchorIndex];
      if (found) {
        // Only the change of the anchor's content position is compensated, so a reader who
        // scrolls while the page loads keeps their own movement. The baseline moves with the
        // block, otherwise the same insertion would be applied again on every later resize.
        const next = contentTop(found);
        const drift = next - anchorAt;
        if (drift) node.scrollTop += drift;
        anchorAt = next;
        previousTop.current = node.scrollTop;
      } else {
        // A block whose text changed with the prefix cannot be matched; use the content height
        // the insertion added above the viewport, and move the baseline by the same amount.
        const next = node.scrollHeight;
        if (next !== height) {
          node.scrollTop += next - height;
          anchorAt += next - height;
          previousTop.current = node.scrollTop;
        }
      }
      height = node.scrollHeight;
    });
    observer.observe(content);
    hold.current = observer;
  }, []);
  const releaseScroll = useCallback(() => {
    hold.current?.disconnect();
    hold.current = null;
  }, []);
  // The pager reads its own cursor through this reference so the callbacks below stay stable.
  const pager = useRef<ConversationWindow | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let error = "";
    const loaded: ConversationWindow = {
      raw: "",
      reader: createConversationStream(workerType),
      before: null,
      after: null,
      done: false,
      started: false,
      prompt: null,
      loadingEarlier: false,
      prefill: PREFILL_PAGES,
    };
    pager.current = loaded;
    const publish = () =>
      show({
        key,
        prompt: loaded.prompt,
        messages: loaded.reader.messages(),
        done: loaded.done,
        started: loaded.started,
        before: loaded.before,
        loadingEarlier: loaded.loadingEarlier,
        error,
      });
    const pump = async () => {
      if (!live) return;
      // `after` is the byte offset of the furthest output already on screen. A first request has
      // no offset yet, so it asks for the tail window instead of the start of the log.
      const first = loaded.after === null && !loaded.done;
      try {
        const page = first
          ? await api.logs(workerId, runId, "events", null, { tail: true })
          : await api.logs(workerId, runId, "events", loaded.after);
        if (!live) return;
        if (page.text) {
          loaded.raw += page.text;
          loaded.reader.push(page.text);
          // Live output grows below the reading position, so it ends the prepend's hold.
          releaseScroll();
        }
        if (first) {
          loaded.before = page.prevCursor ?? null;
          loaded.started = true;
        }
        loaded.after = page.nextCursor;
        loaded.done = page.done || page.nextCursor === null;
        if (loaded.done) loaded.reader.flush();
        error = "";
        // `publish` keeps an empty page with unchanged rows from redrawing the host.
        publish();
        if (!loaded.done)
          timer = setTimeout(
            () => void pump(),
            page.text ? LIVE_POLL_MS : IDLE_POLL_MS,
          );
      } catch {
        if (!live) return;
        // A transient read failure keeps the cursor and retries on the same 1s timer while
        // the short error stays visible; a later page clears it.
        error = "读取失败，正在重试…";
        publish();
        timer = setTimeout(() => void pump(), IDLE_POLL_MS);
      }
    };
    // `/input` is the only source of the user's prompt; Pi echoes of the same prompt are
    // dropped below instead of being shown twice.
    void api
      .input(workerId, runId)
      .then((value) => {
        if (!live) return;
        loaded.prompt = value.prompt;
        publish();
      })
      .catch(() => {
        // An older server has no `/input`; the provider's own user row is the fallback.
      });
    void pump();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      if (pager.current === loaded) pager.current = null;
      // Leaving the conversation tab or the run ends the prepend's hold with its pager.
      releaseScroll();
    };
  }, [api, key, releaseScroll, show, workerId, runId, workerType]);
  /**
   * Reads the page in front of the loaded window. The whole window is parsed again from its own
   * start because a page boundary would otherwise split a streamed message or a tool call from
   * its result into two rows. The scroll position is measured when the page arrives, so a reader
   * who moved while the request was in flight keeps the position they are on when it inserts.
   *
   * The opening fill uses the same request: one in-flight read per run, so a reader who pushes a
   * short first screen cannot ask for a page that is already on its way and insert it twice. A
   * reader gesture also ends the opening fill, which then never reads without a gesture again.
   */
  const loadEarlier = useCallback(
    (options?: { prefilling?: boolean }) => {
      const loaded = pager.current;
      if (!loaded || loaded.before === null) return;
      const prefilling = options?.prefilling === true;
      // A gesture ends the opening fill even when it lands while that fill is already in flight:
      // the reader now owns backward paging, so no further page is read without a gesture.
      if (!prefilling) loaded.prefill = 0;
      if (loaded.loadingEarlier) return;
      if (prefilling) {
        if (loaded.prefill <= 0) return;
        loaded.prefill -= 1;
      }
      loaded.loadingEarlier = true;
      // The opening fill stays invisible: its page is below the newest row the reader is on.
      if (!prefilling)
        show({
          key,
          prompt: loaded.prompt,
          messages: loaded.reader.messages(),
          done: loaded.done,
          started: loaded.started,
          before: loaded.before,
          loadingEarlier: true,
          error: "",
        });
      void api
        .logs(
          workerId,
          runId,
          "events",
          null,
          // A reader's page asks for the full server maximum; the opening fill keeps the
          // cheaper default page so its budget still reads a few times faster than a reader.
          prefilling
            ? { before: loaded.before! }
            : { before: loaded.before!, limit: EARLIER_PAGE_BYTES },
        )
        .then((page) => {
          if (pager.current !== loaded) return;
          loaded.raw = page.text + loaded.raw;
          const reader = createConversationStream(workerType);
          reader.push(loaded.raw);
          if (loaded.done) reader.flush();
          loaded.reader = reader;
          loaded.before = page.prevCursor;
          loaded.loadingEarlier = false;
          // Only a reader who asked for the page keeps their place; the opening fill stays at the
          // newest row because nothing above it was on screen yet.
          if (!prefilling) holdScroll(scroller.current);
          show({
            key,
            prompt: loaded.prompt,
            messages: reader.messages(),
            done: loaded.done,
            started: loaded.started,
            before: loaded.before,
            loadingEarlier: false,
            error: "",
          });
        })
        .catch((caught) => {
          if (pager.current !== loaded) return;
          loaded.loadingEarlier = false;
          show({
            key,
            prompt: loaded.prompt,
            messages: loaded.reader.messages(),
            done: loaded.done,
            started: loaded.started,
            before: loaded.before,
            loadingEarlier: false,
            error: prefilling ? "" : String(caught),
          });
        });
    },
    [api, holdScroll, key, runId, show, workerId, workerType],
  );
  /**
   * Earlier pages load only when the reader really moves up to the top of the loaded window: the
   * first placement and any downward scroll request nothing, so a run's history stays unread
   * until it is asked for. A tail page that fits the panel has no scroll range at all, so a
   * vertical drag over it (or an upward wheel when it does scroll) is the request there. A
   * sideways drag is left to the card and the outer carousel and never reads history.
   */
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    let touching = false;
    let short = false;
    let sideways = false;
    let decided = false;
    let touchX = 0;
    let touchY = 0;
    previousTop.current = node.scrollTop;
    const onScroll = () => {
      const top = node.scrollTop;
      // Shrinking content or a growing viewport clamps the old offset; that is not the reader
      // moving up, so only the record of the last position follows.
      if (previousTop.current > node.scrollHeight - node.clientHeight) {
        previousTop.current = top;
        return;
      }
      if (top < previousTop.current && top <= TOP_PROXIMITY_PX) loadEarlier();
      previousTop.current = top;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && node.scrollTop === 0) loadEarlier();
    };
    const onTouchStart = (event: TouchEvent) => {
      touching = node.scrollTop === 0;
      // A panel with no scroll range has no native vertical movement, so either direction of a
      // vertical drag is the reader asking for the rows above it.
      short = node.scrollHeight <= node.clientHeight;
      sideways = false;
      decided = false;
      touchX = event.touches[0]?.clientX ?? 0;
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!touching) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - touchX;
      const dy = touch.clientY - touchY;
      if (!decided) {
        if (Math.abs(dx) + Math.abs(dy) < TOUCH_SLOP_PX) return;
        decided = true;
        sideways = Math.abs(dx) > Math.abs(dy);
      }
      // The gesture belongs to a horizontal scroller or the outer carousel; a little vertical
      // drift does not turn it into a history request.
      if (sideways) return;
      // A finger pulled down at the top asks for what is above, like a phone transcript; a short
      // panel also accepts the natural upward drag because it has nothing else to scroll.
      if (dy > PULL_STEP_PX || (short && dy < -PULL_STEP_PX)) {
        touchY = touch.clientY;
        loadEarlier();
      }
    };
    const onTouchEnd = () => {
      touching = false;
    };
    // Passive listeners keep the browser free to hand the gesture to the outer page or carousel
    // while the pane still observes it; nothing here calls `preventDefault`.
    node.addEventListener("scroll", onScroll);
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("touchend", onTouchEnd);
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
    };
  }, [loadEarlier]);
  const active =
    conversation.key === key ? conversation : EMPTY_CONVERSATION;
  const view = useMemo(() => {
    // The prompt opens the run, so it is only shown once the window reaches the log start. A tail
    // page of a long run would otherwise put the first prompt under a later answer.
    // Before the tail page arrives `before` is null for lack of knowledge, not because the start
    // is loaded; publishing the prompt there would flash the first prompt above a later answer.
    const showPrompt =
      active.prompt !== null && active.before === null && active.started;
    const rows: WorkerConversationMessage[] = [];
    if (showPrompt)
      rows.push({ id: "__input", role: "user", text: active.prompt! });
    for (const row of active.messages) {
      // Pi echoes the prompt; `/input` is the single source of that row when it is shown.
      if (
        showPrompt &&
        row.role === "user" &&
        row.text.trim() === active.prompt!.trim()
      )
        continue;
      rows.push(row);
    }
    const answered = rows.some(
      (row) => row.role === "assistant" && !row.thinking && row.text.trim(),
    );
    // The stored result is only a fallback once the log really ended without an answer; it
    // goes through the same renderer as one assistant row instead of a separate block.
    const resultOnly = active.done && Boolean(finalText) && !answered;
    if (resultOnly)
      rows.push({ id: "__result", role: "assistant", text: finalText! });
    return {
      rows,
      resultOnly,
      canLoadEarlier: active.before !== null,
      loadingEarlier: active.loadingEarlier,
      inputUnavailable:
        active.done &&
        active.before === null &&
        !active.prompt &&
        !rows.some((row) => row.role === "user"),
      status: active.loadingEarlier
        ? "正在读取更早内容…"
        : active.before !== null
          ? active.done
            ? "已到末尾"
            : "等待新内容"
          : active.done
            ? "已到日志开头"
            : rows.length
              ? "等待新内容…"
              : "正在读取…",
      error: active.error,
    };
  }, [active, finalText]);
  return { view, scroller, loadEarlier, done: active.done };
}

/**
 * Read-only conversation pane shared by the detail console and the overview cards. It renders
 * the optional host conversation view when the host offers it, otherwise the readable fallback,
 * with the same follow-latest behavior for both.
 */
export function ConversationPane({
  api,
  host,
  workerType,
  workerId,
  runId,
  finalText,
  compact = false,
  footer,
}: {
  api: ReturnType<typeof workerApi>;
  host: WorkerHost;
  workerType: WorkerType;
  workerId: string;
  runId: string;
  finalText: string | null;
  compact?: boolean;
  /** Footer controls; the render form receives this pane's independent follow state. */
  footer?:
    | React.ReactNode
    | ((state: {
        follow: boolean;
        setFollow(value: boolean): void;
      }) => React.ReactNode);
}) {
  const conversation = useRunConversation({
    api,
    workerType,
    workerId,
    runId,
    finalText,
  });
  const { view, loadEarlier } = conversation;
  const follow = useFollowLatest(conversation.scroller, view.rows);
  const capability = typeof host.mountConversationOutput === "function";
  /**
   * A tail window with no row at all, or too few rows to browse, would open as an empty or dead
   * first screen while earlier output already exists. Only the opening follows: once a full screen
   * of older rows sits above the newest one (or the reader stopped following) nothing is read
   * without a gesture.
   */
  useEffect(() => {
    if (!follow.follow) return;
    // A window with no row has nothing to measure; extend it before live output can land on top.
    if (view.rows.length === 0) {
      loadEarlier({ prefilling: true });
      return;
    }
    // The host renders the rows it was handed on its own render pass, so a pane with rows is
    // measured a tick later; reading immediately would keep filling while the page is not drawn.
    const timer = setTimeout(() => {
      const node = conversation.scroller.current;
      if (!node) return;
      // jsdom has no layout; without a viewport height a non-empty pane is left alone.
      // A few folded tool rows can overflow by a sliver and still leave nothing to browse, so a
      // window counts as filled only with a whole viewport of older rows above the newest one.
      if (!node.clientHeight || node.scrollHeight - node.clientHeight >= node.clientHeight)
        return;
      loadEarlier({ prefilling: true });
    }, 0);
    // The pager keeps its own in-flight, budget, and cursor guards, so extra passes are no-ops.
    return () => clearTimeout(timer);
  }, [conversation.scroller, loadEarlier, follow.follow, view.rows]);
  return (
    <div className={"worker-conv" + (compact ? " worker-conv-compact" : "")}>
      {view.resultOnly ? (
        <p className="worker-muted">仅显示存储的运行结果。</p>
      ) : null}
      {view.inputUnavailable ? (
        <p className="worker-muted">本次输入记录不可用。</p>
      ) : null}
      <div className="worker-conv-body">
        {capability ? (
          <ConversationHostView
            host={host}
            provider={workerType}
            messages={view.rows}
            scrollRef={conversation.scroller}
          />
        ) : (
          <>
            {!compact ? (
              <p className="worker-muted">当前宿主不支持对话视图。</p>
            ) : null}
            <ConversationFallback
              messages={view.rows}
              loading={!conversation.done && !view.rows.length}
              scrollRef={conversation.scroller}
            />
          </>
        )}
        {!follow.follow ? (
          <button
            className="worker-conv-latest"
            onClick={(event) => {
              event.stopPropagation();
              follow.setFollow(true);
            }}
          >
            回到最新
          </button>
        ) : null}
      </div>
      {view.error ? (
        <p className="worker-error" role="alert">
          {view.error}
        </p>
      ) : null}
      <div className="worker-conv-foot">
        <span className="worker-muted">{view.status}</span>
        {view.canLoadEarlier ? (
          <button
            className="worker-conv-more"
            disabled={view.loadingEarlier}
            onClick={(event) => {
              event.stopPropagation();
              // Asking for older rows is leaving the newest position; a pane that can scroll
              // must not be pulled back to the bottom by the follow effect when the page lands.
              const node = conversation.scroller.current;
              if (follow.follow && node && node.scrollHeight > node.clientHeight)
                follow.setFollow(false);
              loadEarlier();
            }}
          >
            加载更早内容
          </button>
        ) : null}
        {typeof footer === "function" ? footer(follow) : footer}
      </div>
    </div>
  );
}
