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
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.25em] text-[#171717]/40">
            Your question
          </p>

          <h2
            id="answer-title"
            className="text-2xl font-medium leading-relaxed tracking-tight text-[#171717] sm:text-3xl"
          >
            {query}
          </h2>
        </div>

        {/* Answer */}
        <div className="rounded-3xl border border-[#08733F]/10 bg-white/40 p-6 shadow-2xl shadow-[#04552F]/10 backdrop-blur-xl sm:p-8">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#08733F]">
                Answer
              </p>

              <p className="mt-1 text-xs text-[#171717]/40">
                Retrieved from the knowledge base
              </p>
            </div>

            {grounded && (
              <span className="rounded-full border border-[#08733F]/20 bg-[#08733F]/10 px-3 py-1.5 text-xs font-medium text-[#08733F]">
                Grounded
              </span>
            )}
          </div>

          <div className="text-[15px] leading-8 text-[#171717]/80 sm:text-base">
            {answer}
          </div>
        </div>

        {/* Sources */}
        {sources.length > 0 && (
          <div className="mt-10">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-[#171717]/45">
                Retrieved context
              </p>

              <span className="text-xs text-[#171717]/30">
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
    </section>
  );
}

export default AnswerView;