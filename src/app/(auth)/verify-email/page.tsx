import { Suspense } from "react";
import VerifyEmailForm from "./verify-form";

interface VerifyEmailPageProps {
  searchParams: Promise<{ email?: string; code?: string }>;
}

export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const params = await searchParams;
  return (
    <Suspense>
      <VerifyEmailForm email={params.email ?? ""} initialCode={params.code ?? ""} />
    </Suspense>
  );
}
