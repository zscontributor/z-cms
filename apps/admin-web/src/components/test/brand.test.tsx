import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logo, Wordmark } from "../brand";

describe("brand assets", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_BASE_PATH", "/admin");
  });

  it("serves the standalone mark from the admin base path", () => {
    const { container } = render(<Logo />);

    expect(container.querySelector("img")).toHaveAttribute("src", "/admin/brand/icon.png");
  });

  it("serves both wordmark variants from the admin base path", () => {
    const { container } = render(<Wordmark />);
    const images = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

    expect(images).toEqual(["/admin/brand/logo.png", "/admin/brand/logo-dark.png"]);
  });
});
