import Link from "next/link";
import { PageIntro, buttonSecondary } from "@/components/ui";

export default function NotFound() {
  return (
    <>
      <PageIntro section="Customers" title="Customer not found" description="That customer isn't on file, or the link is wrong." />
      <Link href="/customers" className={`${buttonSecondary} w-full sm:w-auto`}>
        Back to customers
      </Link>
    </>
  );
}
