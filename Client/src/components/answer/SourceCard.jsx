function SourceCard({
  source,
  index,
}) {
  const score =
    typeof source.score === "number"
      ? Math.round(source.score * 100)
      : null;

  return (
    <article className="group rounded-2xl border border-white/[0.07] bg-white/[0.025] p-5 transition-all duration-300 hover:border-violet-400/20 hover:bg-white/[0.04]">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-400/10 text-[10px] font-semibold text-violet-300">
            {index + 1}
          </span>

          <span className="text-xs font-medium text-white/50">
            Retrieved context
          </span>
        </div>

        {score !== null && (
          <span className="text-xs font-medium text-violet-300/70">
            {score}% match
          </span>
        )}
      </div>

      <p className="line-clamp-5 text-sm leading-6 text-white/50 transition-colors group-hover:text-white/65">
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
                className="rounded-full border border-white/[0.06] bg-white/[0.025] px-2.5 py-1 text-[10px] text-white/30"
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