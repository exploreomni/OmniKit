const WIDTHS = [75, 60, 85, 70, 90, 65, 80, 55];

export function SkeletonRow({ columns = 4, index = 0 }: { columns?: number; index?: number }) {
  return (
    <div className="flex items-center gap-4 p-3 animate-pulse">
      {Array.from({ length: columns }).map((_, i) => (
        <div
          key={i}
          className="h-4 bg-gray-200 rounded"
          style={{ width: `${WIDTHS[(index * columns + i) % WIDTHS.length]}%` }}
        />
      ))}
    </div>
  );
}
