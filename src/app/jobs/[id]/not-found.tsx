import Link from "next/link";
import { PageIntro, buttonSecondary } from "@/components/ui";

export default function NotFound() {
  return (
    <>
      <PageIntro section="Jobs" title="Job not found" description="That job isn't on file, or the link is wrong." />
      <Link href="/jobs" className={`${buttonSecondary} w-full sm:w-auto`}>
        Back to jobs
      </Link>
    </>
  );
}
