function SourceCard({
  source,
  index,
}) {
  const score =
    typeof source.score === "number"
      ? Math.round(
          Math.max(0, 1 - Math.abs(source.score)) * 100,
        )
      : null;

  return (
    <article className="group rounded-2xl border border-[#08733F]/10 bg-white/40 p-5 transition-all duration-300 hover:border-[#FF0080]/30 hover:bg-white/60">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#08733F]/10 text-[10px] font-semibold text-[#08733F]">
            {index + 1}
          </span>

          <span className="text-xs font-medium text-[#171717]/50">
            Retrieved context
          </span>
        </div>

        {score !== null && (
          <span className="text-xs font-medium text-[#08733F]/80">
            {score}% match
          </span>
        )}
      </div>

      <p className="line-clamp-5 text-sm leading-6 text-[#171717]/55 transition-colors group-hover:text-[#171717]/80">
        {source.text}
      </p>

      {source.metadata && (
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(source.metadata)
            .filter(
              ([, value]) =>
                value !== null &&
                value !== undefined &&
                value !== "",
            )
            .slice(0, 3)
            .map(([key, value]) => (
              <span
                key={key}
                className="rounded-full border border-[#08733F]/10 bg-[#08733F]/[0.04] px-2.5 py-1 text-[10px] text-[#171717]/40"
              >
                {key}: {String(value)}
              </span>
            ))}
        </div>
      )}
    </article>
  );
}

export default SourceCard;