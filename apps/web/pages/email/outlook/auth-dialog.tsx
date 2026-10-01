import Head from "next/head";
import { OutlookAuthDialog } from "../../../components/outlook-auth-dialog";

export default function OutlookAuthDialogPage() {
  return (
    <>
      <Head>
        <title>Microsoft sign-in — Hot Potato</title>
      </Head>
      <OutlookAuthDialog />
    </>
  );
}
