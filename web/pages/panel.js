export async function getServerSideProps() {
  return {
    redirect: {
      destination: '/panel.html',
      permanent: false
    }
  }
}

export default function Panel() {
  return null
}
