import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ManagementClient } from "../../../../components/management-client";
import {
  managedBookingView,
  managedBookingWithVerifiedCalendar,
} from "../../../managed-booking";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Manage your meeting — Hot Potato",
  description: "Reschedule or cancel your meeting.",
};

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) notFound();
  const booking = await managedBookingWithVerifiedCalendar(token);
  if (!booking) notFound();
  return (
    <ManagementClient
      token={token}
      initialBooking={managedBookingView(booking)}
    />
  );
}
