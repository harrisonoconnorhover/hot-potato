import { Head, Html, Main, NextScript } from "next/document";

export default function HotPotatoPagesDocument() {
  return (
    <Html lang="en">
      <Head>
        <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
