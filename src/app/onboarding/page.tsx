/*
 * /onboarding — Server Component. Guards the page itself: requireOnboarding() redirects signed-out
 * visitors to /login and already-staff visitors to /cases before the form ever renders, so
 * revisiting this URL after onboarding already completed (or as an existing staff member) never
 * shows the form again. completeOnboardingAction still re-derives the same guard on submit,
 * since a Server Action can't redirect() itself — the two checks cover different moments
 * (page load vs. submit), not the same one twice.
 */

import { requireOnboarding } from "@/features/auth/context";
import { OnboardingForm } from "./onboarding-form";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  await requireOnboarding();

  return <OnboardingForm />;
}
