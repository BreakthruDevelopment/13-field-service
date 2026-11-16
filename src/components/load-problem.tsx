import { PageIntro } from "@/components/ui";

export function LoadProblem({ section, title, message }: { section: string; title: string; message: string }) {
  return (
    <>
      <PageIntro section={section} title={title} description="This couldn't be loaded." />
      <p role="alert" className="text-sm font-medium text-danger">
        {message}
      </p>
    </>
  );
}
