import SourceCard from "./SourceCard";

function AnswerView({
  query,
  answer,
  sources = [],
  grounded = true,
}) {
  return (
    <section
      aria-labelledby="answer-title"
      className="w-full px-6 py-16"
    >
      <div className="mx-auto w-full max-w-4xl">
        {/* Query */}
        <div className="mb-10">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.25em] text-white/30">
            Your question
          </p>

          <h2
            id="answer-title"
            className="text-2xl font-medium leading-relaxed tracking-tight text-white sm:text-3xl"
          >
            {query}
          </h2>
        </div>

        {/* Answer */}
        <div className="rounded-3xl border border-white/[0.08] bg-white/[0.035] p-6 shadow-2xl shadow-black/20 backdrop-blur-xl sm:p-8">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-violet-300/70">
                Answer
              </p>

              <p className="mt-1 text-xs text-white/30">
                Retrieved from the knowledge base
              </p>
            </div>

            {grounded && (
              <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
                Grounded
              </span>
            )}
          </div>

          <div className="text-[15px] leading-8 text-white/75 sm:text-base">
            {answer}
          </div>
        </div>

        {/* Sources */}
        {sources.length > 0 && (
          <div className="mt-10">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/35">
                Retrieved context
              </p>

              <span className="text-xs text-white/25">
                {sources.length} sources
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
             {sources.length > 0 && (
  <div className="mt-10">
    <div className="mb-4 flex items-center justify-between">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/35">
        Retrieved context
      </p>

      <span className="text-xs text-white/25">
        {sources.length} sources
      </span>
    </div>

    <div className="grid gap-3 sm:grid-cols-2">
      {sources.map((source, index) => (
        <SourceCard
          key={source.id ?? index}
          source={source}
          index={index}
        />
      ))}
    </div>
  </div>
)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default AnswerView;