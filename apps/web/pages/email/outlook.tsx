import Head from "next/head";
import { OutlookEmailComposer } from "../../components/outlook-email-composer";

export default function OutlookEmailComposerPage() {
  return (
    <>
      <Head>
        <title>Insert scheduling — Hot Potato</title>
        <meta
          name="description"
          content="Insert a booking link or live suggested times in Outlook."
        />
      </Head>
      <OutlookEmailComposer />
    </>
  );
}
