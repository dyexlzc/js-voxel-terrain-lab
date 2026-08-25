import { useCallback, useState } from "react";
import Background from "./components/Background";
import BootScreen from "./components/BootScreen";
import Stage from "./components/Stage";

type Phase = "boot" | "stage";

function CornerFrame() {
  const base = "pointer-events-none absolute z-30 h-6 w-6 border-aqua/50";
  return (
    <>
      <span className={`${base} top-2 left-2 border-t-2 border-l-2`} />
      <span className={`${base} top-2 right-2 border-t-2 border-r-2`} />
      <span className={`${base} bottom-2 left-2 border-b-2 border-l-2`} />
      <span className={`${base} right-2 bottom-2 border-r-2 border-b-2`} />
    </>
  );
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [runId, setRunId] = useState(0);

  const handleBooted = useCallback(() => setPhase("stage"), []);

  const handleReplay = useCallback(() => {
    setRunId((n) => n + 1);
    setPhase("boot");
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink text-paper">
      <Background />
      <CornerFrame />
      {phase === "boot" ? (
        <BootScreen key={runId} onDone={handleBooted} />
      ) : (
        <Stage onReplay={handleReplay} />
      )}
    </div>
  );
}
