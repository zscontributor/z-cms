export function adminAssetPath(path: string): string {
  const configuredBasePath =
    process.env.ADMIN_BASE_PATH ?? (process.env.NODE_ENV === "production" ? "/admin" : "");
  const basePath = normalizeBasePath(configuredBasePath);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${suffix}`;
}

function normalizeBasePath(value: string): string {
  if (!value || value === "/") return "";
  return value.startsWith("/") ? value.replace(/\/+$/, "") : `/${value.replace(/\/+$/, "")}`;
}
