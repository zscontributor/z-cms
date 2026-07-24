export default function AdminLoading() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <div className="h-7 w-48 animate-pulse rounded-md bg-[var(--surface-sunken)]" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="z-card h-24 animate-pulse" />
        ))}
      </div>
      <div className="z-card h-64 animate-pulse" />
    </div>
  );
}
