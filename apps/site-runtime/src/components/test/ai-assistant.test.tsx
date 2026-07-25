import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiAssistant } from "../ai-assistant";

/**
 * The chat crashed the whole page the instant a reply arrived, with a minified
 * "destroy is not a function" deep in React's commit. The cause was a one-line
 * effect — `useEffect(() => end.current?.scrollIntoView(...), deps)` — whose
 * concise arrow hands React the RETURN of `scrollIntoView` as its cleanup. Some
 * browsers implement `behavior: "smooth"` by returning a Promise, so React called
 * that Promise as a destroy function on the next render (every new message), and
 * the tree came down.
 *
 * This test pins the fix by reproducing exactly that browser: `scrollIntoView`
 * returns a Promise, a message is sent, and the reply must render without the
 * effect cleanup throwing.
 */

describe("AiAssistant", () => {
  beforeEach(() => {
    // The trigger: a smooth-scroll implementation that returns a (thenable) Promise
    // rather than undefined. jsdom ships no scrollIntoView at all, so we define one.
    Element.prototype.scrollIntoView = vi.fn(
      () => Promise.resolve(),
    ) as unknown as (arg?: unknown) => void;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ answer: "Mình có thể giúp gì cho bạn?" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the reply after sending, even when scrollIntoView returns a Promise", async () => {
    render(<AiAssistant name="Trợ lý" welcomeMessage="Chào mừng" />);

    fireEvent.click(screen.getByLabelText("Open Trợ lý"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "xin chào" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    // The user's message renders immediately; the effect's cleanup runs on this
    // very re-render — the moment that used to crash.
    expect(await screen.findByText("xin chào")).toBeInTheDocument();
    // And the awaited reply lands on the next state update without the tree dying.
    expect(await screen.findByText("Mình có thể giúp gì cho bạn?")).toBeInTheDocument();
  });

  it("shows an error bubble instead of crashing when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "AI request failed." }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    render(<AiAssistant name="Trợ lý" welcomeMessage="Chào mừng" />);
    fireEvent.click(screen.getByLabelText("Open Trợ lý"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByText("AI request failed.")).toBeInTheDocument();
  });
});
