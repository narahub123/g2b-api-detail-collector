"use client";

import { useCallback, useState } from "react";
import type { CollectionJob } from "@/lib/g2b/collection-job";
import { CollectionForm } from "./CollectionForm";
import { AutomationSettingsForm } from "./AutomationSettingsForm";
import { CollectionJobProgress } from "./CollectionJobProgress";
import { FormAccordion } from "./FormAccordion";
import "../app/collection-progress.css";

/** 두 수집 설정 영역과 공통 진행 결과의 배치를 관리합니다. */
export function CollectionManager() {
  const [job, setJob] = useState<CollectionJob | null>(null);
  const onJobChange = useCallback(
    (next: CollectionJob | null) => setJob(next),
    [],
  );
  return (
    <>
      <CollectionForm onJobChange={onJobChange} showProgress={false} />

      <AutomationSettingsForm />
      {job && job.mode !== "refresh" && (
        <FormAccordion
          title="수집 진행 결과"
          defaultOpen
          className="collection-progress-section"
        >
          <CollectionJobProgress job={job} />
        </FormAccordion>
      )}
    </>
  );
}
