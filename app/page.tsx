export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <p className="text-sm uppercase tracking-[0.2em] text-red-400">BlackBox</p>
      <h1 className="text-3xl font-semibold">Flight recorder for EMS crews.</h1>
      <p className="text-neutral-400">
        One in seven New York EMS calls turns out to be something other than what
        it was dispatched as. BlackBox captures the decision and the reason.
      </p>
    </main>
  );
}
