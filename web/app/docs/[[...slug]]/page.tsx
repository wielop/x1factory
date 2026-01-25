export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

type DocsPageProps = {
  params: {
    slug?: string[];
  };
};

export default function DocsPage({ params }: DocsPageProps) {
  const slug = params.slug ?? [];
  const destination = ["https://docs.x1factory.xyz", ...slug].join("/");
  redirect(destination);
}
